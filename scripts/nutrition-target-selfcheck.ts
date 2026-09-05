import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { TARGET_POLICY_VERSION, nutritionRecommendationSchema, recommendNutritionTarget, type NutritionTargetSetup } from '../src/nutrition/target-policy.js';
import { NutritionTarget, toPublicNutritionTarget } from '../src/models/nutritionTarget.model.js';
import { nutritionService } from '../src/services/nutrition.service.js';
import { updateNutritionTargetSchema } from '../src/validators/nutrition.validator.js';
import { ApiError } from '../src/utils/apiError.js';

const setup: NutritionTargetSetup = { age: 30, gender: 'male', heightCm: 175, weightKg: 70, activityLevel: 'sedentary', goal: 'maintain' };
const development = { isProduction: false, approvalVersion: '' };
const calculate = (overrides: Partial<NutritionTargetSetup> = {}) => recommendNutritionTarget({ setup: { ...setup, ...overrides }, eligibilityConfirmed: true }, development);
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

await check('Mifflin male example, maintenance and bodyweight protein', () => {
  const result = calculate();
  assert.equal(result.bmrKcal, 1648.8);
  assert.equal(result.tdeeKcal, 1978.5);
  assert.deepEqual(result.target, { kcal: 1980, proteinG: 112, carbsG: 234.5, fatG: 66 });
  assert.equal(result.reviewed, false);
});
await check('Mifflin female constant and activity multiplier', () => {
  const result = calculate({ gender: 'female', weightKg: 60, heightCm: 165, activityLevel: 'light' });
  assert.equal(result.bmrKcal, 1320.3);
  assert.equal(result.tdeeKcal, 1815.3);
  assert.equal(result.target.kcal, 1820);
  assert.equal(result.target.proteinG, 96);
});
await check('goal directions and 300 kcal adjustment cap', () => {
  assert.equal(calculate({ goal: 'lose_fat' }).target.kcal, 1780);
  assert.equal(calculate({ goal: 'gain_weight' }).target.kcal, 2180);
  const active = calculate({ weightKg: 90, heightCm: 190, activityLevel: 'very_active' });
  assert.equal(calculate({ weightKg: 90, heightCm: 190, activityLevel: 'very_active', goal: 'gain_weight' }).target.kcal - active.target.kcal, 300);
});
await check('candidate floor applied with a visible warning, not a safety guarantee', () => {
  const result = calculate({ gender: 'female', age: 78, heightCm: 155, weightKg: 50, goal: 'lose_fat' });
  assert.equal(result.target.kcal, 1500);
  assert.ok(result.warnings.some((warning) => warning.includes('minimum')));
});
await check('unsupported measurements and oversized estimates do not get fabricated targets', () => {
  assert.throws(() => calculate({ heightCm: 180, weightKg: 40 }), ApiError);
  assert.throws(() => calculate({ heightCm: 230, weightKg: 200, age: 18, activityLevel: 'very_active' }), ApiError);
  assert.throws(() => calculate({ heightCm: 180, weightKg: 140, age: 78, goal: 'lose_fat' }), ApiError);
});
for (const [field, value] of Object.entries({ age: 17, gender: 'unknown', heightCm: 0, weightKg: Infinity, activityLevel: 'advanced', goal: 'build_strength' })) {
  await check(`invalid ${field} is rejected rather than defaulted`, () => {
    assert.equal(nutritionRecommendationSchema.safeParse({ setup: { ...setup, [field]: value }, eligibilityConfirmed: true }).success, false);
  });
}
await check('missing acknowledgement, fractional age and age outside support are rejected', () => {
  for (const age of [18.5, 79, NaN]) assert.equal(nutritionRecommendationSchema.safeParse({ setup: { ...setup, age }, eligibilityConfirmed: true }).success, false);
  assert.equal(nutritionRecommendationSchema.safeParse({ setup }).success, false);
  assert.equal(nutritionRecommendationSchema.safeParse({ setup, eligibilityConfirmed: false }).success, false);
  assert.equal(nutritionRecommendationSchema.safeParse({ setup, eligibilityConfirmed: true, userId: 'another-user' }).success, false);
});
await check('production review gate is closed unless the exact policy was approved', () => {
  for (const approvalVersion of ['', 'true', 'old-version']) {
    assert.throws(() => recommendNutritionTarget({ setup, eligibilityConfirmed: true }, { isProduction: true, approvalVersion }), (error: unknown) => error instanceof ApiError && error.code === 'TARGET_POLICY_REVIEW_REQUIRED');
  }
  const result = recommendNutritionTarget({ setup, eligibilityConfirmed: true }, { isProduction: true, approvalVersion: TARGET_POLICY_VERSION });
  assert.equal(result.reviewed, true);
});
await check('macro energy reconciles across a representative input grid', () => {
  for (const age of [18, 40, 78]) for (const gender of ['male', 'female'] as const) for (const weightKg of [50, 70, 100, 140]) for (const heightCm of [155, 175, 195]) for (const activityLevel of ['sedentary', 'light', 'moderate', 'very_active'] as const) for (const goal of ['maintain', 'lose_fat', 'gain_weight'] as const) {
    try {
      const { target } = calculate({ age, gender, weightKg, heightCm, activityLevel, goal });
      assert.ok(target.kcal >= 1500 && target.kcal <= 4000);
      assert.ok(target.carbsG >= 0 && target.proteinG > 0 && target.fatG > 0);
      assert.ok(Math.abs(target.kcal - (target.proteinG * 4 + target.carbsG * 4 + target.fatG * 9)) <= 0.21);
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 422) throw error;
    }
  }
});
await check('setup is validated, roundtripped privately and optional for existing targets', () => {
  assert.equal(updateNutritionTargetSchema.safeParse({ setup }).success, true);
  assert.equal(updateNutritionTargetSchema.safeParse({ setup: { ...setup, age: 12 } }).success, false);
  const target = new NutritionTarget({ userId: new mongoose.Types.ObjectId(), kcal: 2000, proteinG: 100, carbsG: 250, fatG: 65, setup, updatedAt: new Date() });
  assert.equal(target.validateSync(), undefined);
  assert.deepEqual(toPublicNutritionTarget(target).setup, setup);
  const old = new NutritionTarget({ userId: new mongoose.Types.ObjectId(), kcal: 2000, proteinG: 100, carbsG: 250, fatG: 65, updatedAt: new Date() });
  assert.equal(toPublicNutritionTarget(old).setup, undefined);
});
await check('partial target patches stay scoped to one user and cannot create incomplete targets', async () => {
  const original = NutritionTarget.findOneAndUpdate;
  const userId = new mongoose.Types.ObjectId();
  let call: unknown[] = [];
  try {
    NutritionTarget.findOneAndUpdate = ((...args: unknown[]) => { call = args; return Promise.resolve(null); }) as unknown as typeof original;
    await assert.rejects(nutritionService.updateTarget(userId, { proteinG: 123 }), (error: unknown) => error instanceof ApiError && error.statusCode === 422);
    assert.deepEqual(call[0], { userId });
    assert.deepEqual(call[1], { $set: { proteinG: 123 } });
    assert.equal((call[2] as { upsert: boolean }).upsert, false);
  } finally { NutritionTarget.findOneAndUpdate = original; }
});
await check('simultaneous first saves retry an atomic update after duplicate-key race', async () => {
  const original = NutritionTarget.findOneAndUpdate;
  const calls: unknown[][] = [];
  const userId = new mongoose.Types.ObjectId();
  const input = { kcal: 2000, proteinG: 100, carbsG: 250, fatG: 65, setup };
  try {
    NutritionTarget.findOneAndUpdate = ((...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 1) return Promise.reject({ code: 11000 });
      return Promise.resolve(new NutritionTarget({ userId, ...input, updatedAt: new Date() }));
    }) as unknown as typeof original;
    const saved = await nutritionService.updateTarget(userId, input);
    assert.equal(calls.length, 2);
    assert.equal((calls[0]![2] as { upsert: boolean }).upsert, true);
    assert.equal((calls[1]![2] as { upsert?: boolean }).upsert, undefined);
    assert.deepEqual(saved.setup, setup);
    assert.deepEqual(calls[1]![0], { userId });
  } finally { NutritionTarget.findOneAndUpdate = original; }
});
console.log(`\n${passed} nutrition-target checks passed.\n`);

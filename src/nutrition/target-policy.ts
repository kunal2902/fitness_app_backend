import { z } from 'zod';

import { ApiError } from '../utils/apiError.js';

/** Candidate policy, NOT clinical approval. Production requires this exact
 * version in NUTRITION_TARGET_POLICY_APPROVAL after the review is recorded. */
export const TARGET_POLICY_VERSION = 'mifflin-v1-candidate-1';
export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'very_active'] as const;
export const TARGET_GOALS = ['maintain', 'lose_fat', 'gain_weight'] as const;
export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, very_active: 1.725,
} as const;

// These input limits match the supported profile ranges, except age, which
// is adult-only, with an upper limit at the equation's studied age range.
export const nutritionTargetSetupSchema = z.object({
  age: z.number().finite().int().min(18).max(78),
  gender: z.enum(['male', 'female']),
  heightCm: z.number().finite().min(120).max(230),
  weightKg: z.number().finite().min(30).max(200),
  activityLevel: z.enum(ACTIVITY_LEVELS),
  goal: z.enum(TARGET_GOALS),
}).strict();

export const nutritionRecommendationSchema = z.object({
  setup: nutritionTargetSetupSchema,
  eligibilityConfirmed: z.literal(true),
}).strict();

export type NutritionTargetSetup = z.infer<typeof nutritionTargetSetupSchema>;
export type NutritionRecommendationInput = z.infer<typeof nutritionRecommendationSchema>;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Read-only preview: never creates/updates a target, including on signup. */
export function recommendNutritionTarget(
  input: NutritionRecommendationInput,
  policy: { isProduction: boolean; approvalVersion: string },
) {
  const { setup } = nutritionRecommendationSchema.parse(input);
  const reviewed = policy.approvalVersion === TARGET_POLICY_VERSION;
  if (policy.isProduction && !reviewed) {
    throw ApiError.forbidden(
      'Personal estimates are awaiting review. You can still enter your own targets.',
      'TARGET_POLICY_REVIEW_REQUIRED',
    );
  }
  const bmi = setup.weightKg / (setup.heightCm / 100) ** 2;
  if (bmi < 18.5) {
    throw ApiError.validation(
      { weightKg: 'These measurements need individual guidance; no automatic estimate is available.' },
      'Please discuss suitable targets with a qualified health professional.',
    );
  }

  // Mifflin-St Jeor, simplified sex-specific equation (1990).
  const bmrKcal = 10 * setup.weightKg + 6.25 * setup.heightCm - 5 * setup.age +
    (setup.gender === 'male' ? 5 : -161);
  const tdeeKcal = bmrKcal * ACTIVITY_MULTIPLIERS[setup.activityLevel];
  const adjustment = Math.min(300, tdeeKcal * 0.1);
  const adjusted = tdeeKcal + (setup.goal === 'lose_fat' ? -adjustment :
    setup.goal === 'gain_weight' ? adjustment : 0);
  // Candidate recommendation range; not a universal safe-intake claim.
  // Do not clamp a very high estimate down into a misleading recommendation.
  if (adjusted > 4000) {
    throw ApiError.validation({ activityLevel: 'This estimate is outside the supported range. Seek individual guidance.' });
  }
  const kcal = Math.max(1500, Math.round(adjusted / 10) * 10);
  const proteinG = round1(setup.weightKg * 1.6);
  if (proteinG * 4 > kcal * 0.35) {
    throw ApiError.validation({ weightKg: 'A bodyweight-based macro split is not suitable for these inputs. Seek individual guidance.' });
  }
  const fatG = round1(kcal * 0.3 / 9);
  const carbsG = round1((kcal - proteinG * 4 - fatG * 9) / 4);
  const warnings = [
    'An estimate, not medical advice. Review all four targets before saving.',
    'Not for pregnancy, breastfeeding, under-18s, or people needing a medically prescribed diet.',
    ...(!reviewed ? ['Development preview: formula settings and safety copy are awaiting review.'] : []),
    ...(adjusted < 1500 ? ['The candidate minimum of 1500 kcal was applied. Individual needs may be higher.'] : []),
  ];
  return {
    setup,
    target: { kcal, proteinG, carbsG, fatG },
    bmrKcal: round1(bmrKcal),
    tdeeKcal: round1(tdeeKcal),
    policyVersion: TARGET_POLICY_VERSION,
    reviewed,
    warnings,
  };
}

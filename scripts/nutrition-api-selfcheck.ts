/** Database-free checks for the Step 3 nutrition API contract. */
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { FOOD_SOURCES } from '../src/nutrition/food.schema.js';
import {
  isMatchingGramAmount,
  macrosForGrams,
  servingQuantityToGrams,
} from '../src/nutrition/nutrition-math.js';
import { Food } from '../src/models/food.model.js';
import { FoodLog, type PublicFoodLog } from '../src/models/foodLog.model.js';
import { calculateFrecencyScore } from '../src/services/food.service.js';
import { buildDailySummary } from '../src/services/nutrition.service.js';
import {
  createNutritionLogSchema,
  diaryDateSchema,
  foodParamsSchema,
  foodSearchQuerySchema,
  updateNutritionLogSchema,
  updateNutritionTargetSchema,
} from '../src/validators/nutrition.validator.js';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function group(name: string) {
  console.log(`\n${name}\n`);
}

function fixtureLog(): PublicFoodLog {
  return {
    id: '507f1f77bcf86cd799439011',
    date: '2026-08-28',
    mealType: 'breakfast',
    clientId: 'offline-1',
    notes: null,
    createdAt: '2026-08-28T02:30:00.000Z',
    updatedAt: '2026-08-28T02:30:00.000Z',
    items: [
      {
        foodId: '507f1f77bcf86cd799439012',
        grams: 150,
        quantity: 1,
        unitLabel: '1 katori',
        snapshot: {
          externalId: 'ifct:A001',
          name: 'Rice',
          per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3 },
          source: 'ifct2017',
          sourceVersion: '2017',
        },
        macros: { kcal: 195, proteinG: 4.05, carbsG: 42, fatG: 0.45 },
      },
      {
        foodId: '507f1f77bcf86cd799439013',
        grams: 200,
        quantity: 1,
        unitLabel: '1 glass',
        snapshot: {
          externalId: 'ifct:M001',
          name: 'Milk',
          per100g: { kcal: 60, proteinG: 3.2, carbsG: 4.8, fatG: 3.3 },
          source: 'ifct2017',
          sourceVersion: '2017',
        },
        macros: { kcal: 120, proteinG: 6.4, carbsG: 9.6, fatG: 6.6 },
      },
    ],
  };
}

async function main() {
  group('Nutrition calculations');

  await check('quantity multiplied by serving grams is canonical', () => {
    assert.equal(servingQuantityToGrams(150, 1.5), 225);
  });

  await check('macros scale from the frozen per-100 g snapshot', () => {
    assert.deepEqual(
      macrosForGrams(
        { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3 },
        150,
      ),
      { kcal: 195, proteinG: 4.05, carbsG: 42, fatG: 0.45 },
    );
  });

  await check('portion mismatch tolerance accepts rounding, not bad weights', () => {
    assert.equal(isMatchingGramAmount(149.9, 150), true);
    assert.equal(isMatchingGramAmount(100, 150), false);
  });

  await check('daily and meal totals equal the sum of logged items', () => {
    const summary = buildDailySummary([fixtureLog()]);
    assert.deepEqual(summary.totals, {
      kcal: 315,
      proteinG: 10.45,
      carbsG: 51.6,
      fatG: 7.05,
    });
    assert.deepEqual(summary.meals[0], {
      mealType: 'breakfast',
      totals: summary.totals,
      logCount: 1,
      itemCount: 2,
    });
    assert.equal(summary.meals[1]?.itemCount, 0);
  });

  await check('recent frequent foods outrank old one-off foods', () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const recent = calculateFrecencyScore(
      5,
      new Date('2026-08-27T00:00:00.000Z'),
      now,
    );
    const old = calculateFrecencyScore(
      1,
      new Date('2026-05-01T00:00:00.000Z'),
      now,
    );
    assert.ok(recent > old);
  });

  group('Nutrition validation');

  await check('food-source enum is byte-identical to the client contract', () => {
    assert.deepEqual(FOOD_SOURCES, [
      'ifct2017',
      'indb',
      'usda',
      'openfoodfacts',
      'user',
    ]);
  });

  await check('diary dates reject timezone values and impossible dates', () => {
    assert.ok(diaryDateSchema.safeParse('2026-02-28').success);
    assert.ok(!diaryDateSchema.safeParse('2026-02-30').success);
    assert.ok(!diaryDateSchema.safeParse('2026-08-28T00:00:00Z').success);
  });

  await check('search query trims and bounds its limit', () => {
    const parsed = foodSearchQuerySchema.parse({ q: '  poha  ' });
    assert.equal(parsed.q, 'poha');
    assert.equal(parsed.limit, 20);
    assert.ok(!foodSearchQuerySchema.safeParse({ q: 'x', limit: 51 }).success);
  });

  await check('food detail accepts Mongo and stable external ids', () => {
    assert.ok(
      foodParamsSchema.safeParse({ id: '507f1f77bcf86cd799439011' }).success,
    );
    assert.ok(foodParamsSchema.safeParse({ id: 'ifct:A011' }).success);
    assert.ok(!foodParamsSchema.safeParse({ id: 'unknown' }).success);
  });

  await check('log requests use server snapshots, not client snapshots', () => {
    const parsed = createNutritionLogSchema.parse({
      date: '2026-08-28',
      mealType: 'lunch',
      items: [
        {
          foodId: '507f1f77bcf86cd799439011',
          grams: 150,
          quantity: 1,
          unitLabel: '1 katori',
          snapshot: { per100g: { kcal: 0 } },
        },
      ],
      clientId: 'device-entry-1',
    });
    const first = parsed.items[0];
    assert.ok(first);
    assert.equal('snapshot' in first, false);
  });

  await check('logs reject invalid meal types and non-positive portions', () => {
    const base = {
      date: '2026-08-28',
      mealType: 'lunch',
      items: [
        {
          foodId: '507f1f77bcf86cd799439011',
          grams: 150,
          quantity: 1,
          unitLabel: '1 katori',
        },
      ],
    };
    assert.ok(createNutritionLogSchema.safeParse(base).success);
    assert.ok(
      !createNutritionLogSchema.safeParse({ ...base, mealType: 'brunch' }).success,
    );
    assert.ok(
      !createNutritionLogSchema.safeParse({
        ...base,
        items: [{ ...base.items[0], grams: 0 }],
      }).success,
    );
  });

  await check('empty log and target patches are rejected', () => {
    assert.ok(!updateNutritionLogSchema.safeParse({}).success);
    assert.ok(!updateNutritionTargetSchema.safeParse({}).success);
  });

  await check('target validation rejects extreme calorie inputs', () => {
    assert.ok(
      !updateNutritionTargetSchema.safeParse({ kcal: 999 }).success,
    );
    assert.ok(
      updateNutritionTargetSchema.safeParse({ kcal: 2_200 }).success,
    );
  });

  group('Nutrition indexes');

  await check('food catalogue has a text-search index', () => {
    const indexes = Food.schema.indexes() as Array<
      [Record<string, unknown>, Record<string, unknown>]
    >;
    const textIndex = indexes.find(([keys]) =>
      Object.values(keys).some((value) => value === 'text'),
    );
    assert.ok(textIndex, 'missing food text index');
  });

  await check('clientId is unique only when it is a string', () => {
    const indexes = FoodLog.schema.indexes() as Array<
      [Record<string, unknown>, Record<string, unknown>]
    >;
    const index = indexes
      .find(([, options]) => options.name === 'food_log_idempotency');
    assert.ok(index, 'missing idempotency index');
    assert.equal(index?.[1].unique, true);
    assert.deepEqual(index?.[1].partialFilterExpression, {
      clientId: { $type: 'string' },
    });
  });

  group('Nutrition routes are guarded');

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const guarded: Array<[string, string, unknown?]> = [
    ['GET', '/foods/search?q=poha'],
    ['GET', '/foods/507f1f77bcf86cd799439011'],
    ['GET', '/nutrition/logs?date=2026-08-28'],
    ['POST', '/nutrition/logs', {}],
    ['PATCH', '/nutrition/logs/507f1f77bcf86cd799439011', {}],
    ['DELETE', '/nutrition/logs/507f1f77bcf86cd799439011'],
    ['GET', '/nutrition/summary?date=2026-08-28'],
    ['GET', '/nutrition/targets'],
    ['PATCH', '/nutrition/targets', {}],
    ['POST', '/nutrition/targets/recommendation', {}],
  ];

  for (const [method, path, body] of guarded) {
    await check(`${method} ${path} requires authentication`, async () => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 401);
      const payload = (await response.json()) as { code?: string };
      assert.equal(payload.code, 'NO_TOKEN');
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  // Let Node drain the server's closed libuv handles. An immediate exit here
  // intermittently trips UV_HANDLE_CLOSING on Windows after a successful run.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

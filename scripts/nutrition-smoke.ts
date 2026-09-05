/** End-to-end Step 3 nutrition smoke test against an isolated MongoDB. */
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

const VALID_PROFILE = {
  gender: 'male',
  heightCm: 178,
  heightUnit: 'cm',
  weightKg: 74.5,
  weightUnit: 'kg',
  goals: ['build_strength'],
  maxPullUps: '11_15',
  maxPushUps: '21_30',
  maxSquats: '31_40',
  maxDips: '9_15',
  fitnessLevel: 'intermediate',
};

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
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

async function main() {
  const host = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  process.env.MONGO_URI = `${host.replace(/\/$/, '')}/fitness_app_nutrition_test`;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'nutrition-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'nutrition-test-refresh-secret';
  process.env.PORT = '0';
  // Smoke tests never depend on a live third party. The one USDA path below
  // replaces the adapter with a deterministic fixture.
  process.env.FDC_API_KEY = '';

  const [
    { createApp },
    { Food },
    { FoodLog },
    { NutritionTarget },
    { usdaFoodDataService },
    { transformUsdaFood },
  ] =
    await Promise.all([
      import('../src/app.js'),
      import('../src/models/food.model.js'),
      import('../src/models/foodLog.model.js'),
      import('../src/models/nutritionTarget.model.js'),
      import('../src/services/usda-food-data.service.js'),
      import('../src/nutrition/usda-food-data.js'),
    ]);

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5_000 });
  await mongoose.connection.dropDatabase();
  await Promise.all([Food.syncIndexes(), FoodLog.syncIndexes(), NutritionTarget.syncIndexes()]);

  const food = await Food.create({
    externalId: 'ifct:TEST001',
    name: 'Rice flakes (Poha)',
    scientificName: 'Oryza sativa',
    aliases: [{ lang: 'hindi', name: 'Poha' }],
    searchTerms: ['rice flakes poha', 'poha'],
    group: 'Cereals and Millets',
    dietaryTags: ['vegetarian'],
    per100g: { kcal: 350, proteinG: 7, carbsG: 76, fatG: 1.2 },
    servings: [
      {
        label: '1 katori',
        grams: 150,
        isDefault: true,
        origin: 'source_dataset',
        evidence: {
          sourceName: 'Smoke fixture',
          sourceUrl: 'https://example.com/fixture',
          sourceLocator: 'row 1',
          notes: 'Test only',
        },
      },
      {
        label: '100 g',
        grams: 100,
        isDefault: false,
        origin: 'fallback_100g',
        evidence: null,
      },
    ],
    source: 'ifct2017',
    sourceName: 'Smoke fixture',
    sourceVersion: 'test-1',
    sourceUrl: 'https://example.com/fixture',
    sourceAttribution: null,
    licence: 'TEST ONLY',
    energySource: 'source_kj',
    verified: true,
    isRecipe: false,
  });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, any>,
    };
  };

  let token = '';
  let logId = '';

  console.log('\nNutrition API smoke\n');

  await check('signup supplies an authenticated member', async () => {
    const response = await call('POST', '/auth/signup', {
      username: 'nutrition_tester',
      fullName: 'Nutrition Tester',
      email: 'nutrition@example.com',
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    token = response.json.data.tokens.accessToken;
  });

  await check('search finds poha and returns its serving', async () => {
    const response = await call('GET', '/foods/search?q=poha', undefined, token);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.data.foods[0].id, food._id.toString());
    assert.equal(response.json.data.foods[0].servings[0].label, '1 katori');
  });

  const originalUsdaSearch = usdaFoodDataService.search;
  let usdaRequests = 0;
  usdaFoodDataService.search = async (query) => {
    usdaRequests += 1;
    const isPoha = query.toLocaleLowerCase('en').includes('poha');
    return {
      status: 'success',
      rejectedCount: 0,
      foods: [
        transformUsdaFood({
          fdcId: isPoha ? 2020714 : 2020713,
          description: isPoha ? 'POHA, PREPARED' : 'OATS',
          dataType: 'Branded',
          foodCategory: 'Cereal',
          publicationDate: '2026-04-01',
          servingSize: 40,
          servingSizeUnit: 'g',
          householdServingFullText: '1/2 cup',
          foodNutrients: [
            { nutrientId: 1003, unitName: 'G', value: 12.5 },
            { nutrientId: 1004, unitName: 'G', value: 6.25 },
            { nutrientId: 1005, unitName: 'G', value: 67.5 },
            { nutrientId: 1008, unitName: 'KCAL', value: 375 },
          ],
        }),
      ],
    };
  };
  try {
    await check('a local miss imports and caches a USDA result', async () => {
      const first = await call('GET', '/foods/search?q=oats', undefined, token);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.data.foods[0].externalId, 'usda:2020713');
      assert.equal(first.json.data.foods[0].name, 'Oats');
      assert.equal(first.json.data.foods[0].servings[0].label, '1/2 cup');
      assert.equal(usdaRequests, 1);

      const cached = await call('GET', '/foods/search?q=oats', undefined, token);
      assert.equal(cached.status, 200, JSON.stringify(cached.json));
      assert.equal(cached.json.data.foods[0].externalId, 'usda:2020713');
      assert.equal(usdaRequests, 1);
    });

    await check('a sparse local page is globally expanded only once', async () => {
      const first = await call('GET', '/foods/search?q=poha', undefined, token);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(
        first.json.data.foods.some(
          (candidate: { externalId: string }) =>
            candidate.externalId === 'usda:2020714',
        ),
        true,
      );
      assert.equal(usdaRequests, 2);

      const cached = await call('GET', '/foods/search?q=poha', undefined, token);
      assert.equal(cached.status, 200, JSON.stringify(cached.json));
      assert.equal(usdaRequests, 2);
    });
  } finally {
    usdaFoodDataService.search = originalUsdaSearch;
  }

  await check('a disabled global provider does not break local search', async () => {
    const response = await call(
      'GET',
      '/foods/search?q=definitely-no-such-food',
      undefined,
      token,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.deepEqual(response.json.data.foods, []);
    assert.equal(response.json.data.globalLookupUnavailable, true);
  });

  await check('food detail accepts a stable external id', async () => {
    const response = await call('GET', '/foods/ifct:TEST001', undefined, token);
    assert.equal(response.status, 200);
    assert.equal(response.json.data.food.name, 'Rice flakes (Poha)');
  });

  await check('invalid diary dates are rejected', async () => {
    const response = await call(
      'GET',
      '/nutrition/logs?date=2026-02-30',
      undefined,
      token,
    );
    assert.equal(response.status, 422);
  });

  const createBody = {
    date: '2026-08-28',
    mealType: 'breakfast',
    clientId: 'offline-log-1',
    items: [
      {
        foodId: food._id.toString(),
        grams: 225,
        quantity: 1.5,
        unitLabel: '1 katori',
      },
    ],
  };

  await check('a valid portion creates a frozen food log', async () => {
    const response = await call('POST', '/nutrition/logs', createBody, token);
    assert.equal(response.status, 201, JSON.stringify(response.json));
    logId = response.json.data.log.id;
    assert.equal(response.json.data.log.items[0].grams, 225);
    assert.equal(response.json.data.log.items[0].snapshot.per100g.kcal, 350);
    assert.equal(response.json.data.log.items[0].macros.kcal, 787.5);
  });

  await check('retrying clientId does not double-post', async () => {
    const response = await call('POST', '/nutrition/logs', createBody, token);
    assert.equal(response.status, 200);
    assert.equal(response.json.data.duplicate, true);
    assert.equal(response.json.data.log.id, logId);
    assert.equal(await FoodLog.countDocuments(), 1);
  });

  await check('inconsistent serving grams are rejected', async () => {
    const response = await call(
      'POST',
      '/nutrition/logs',
      {
        ...createBody,
        clientId: 'offline-log-2',
        items: [{ ...createBody.items[0], grams: 100 }],
      },
      token,
    );
    assert.equal(response.status, 422);
    assert.ok(response.json.errors.grams);
  });

  await check('catalogue edits do not rewrite historical summary macros', async () => {
    food.per100g.kcal = 1;
    await food.save();
    const response = await call(
      'GET',
      '/nutrition/summary?date=2026-08-28',
      undefined,
      token,
    );
    assert.equal(response.status, 200);
    assert.equal(response.json.data.summary.totals.kcal, 787.5);
    assert.equal(response.json.data.summary.meals[0].mealType, 'breakfast');
  });

  await check('log edits stay scoped and preserve untouched snapshots', async () => {
    const response = await call(
      'PATCH',
      `/nutrition/logs/${logId}`,
      { mealType: 'lunch', notes: 'Moved meal' },
      token,
    );
    assert.equal(response.status, 200);
    assert.equal(response.json.data.log.mealType, 'lunch');
    assert.equal(response.json.data.log.items[0].snapshot.per100g.kcal, 350);
  });

  await check('the first target update requires all macros', async () => {
    const response = await call(
      'PATCH',
      '/nutrition/targets',
      { kcal: 2_200 },
      token,
    );
    assert.equal(response.status, 422);
  });

  await check('targets create, patch, and read back', async () => {
    const created = await call(
      'PATCH',
      '/nutrition/targets',
      { kcal: 2_200, proteinG: 140, carbsG: 260, fatG: 70 },
      token,
    );
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const patched = await call(
      'PATCH',
      '/nutrition/targets',
      { proteinG: 150 },
      token,
    );
    assert.equal(patched.status, 200);
    const fetched = await call('GET', '/nutrition/targets', undefined, token);
    assert.equal(fetched.json.data.target.kcal, 2_200);
    assert.equal(fetched.json.data.target.proteinG, 150);
  });

  let secondToken = '';
  await check('a second real account can authenticate independently', async () => {
    const response = await call('POST', '/auth/signup', {
      username: 'nutrition_second', fullName: 'Second Test Member',
      email: 'nutrition-second@example.com', password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    secondToken = response.json.data.tokens.accessToken;
  });

  await check('other accounts cannot read private logs or targets', async () => {
    assert.ok(secondToken);
    const logs = await call('GET', '/nutrition/logs?date=2026-08-28', undefined, secondToken);
    const targets = await call('GET', '/nutrition/targets', undefined, secondToken);
    const summary = await call('GET', '/nutrition/summary?date=2026-08-28', undefined, secondToken);
    assert.equal(logs.status, 200);
    assert.deepEqual(logs.json.data.logs, []);
    assert.equal(targets.json.data.target, null);
    assert.equal(summary.json.data.summary.totals.kcal, 0);
  });

  await check('other accounts cannot edit or delete a known log ID', async () => {
    assert.ok(secondToken && logId);
    assert.equal((await call('PATCH', `/nutrition/logs/${logId}`, { notes: 'not mine' }, secondToken)).status, 404);
    assert.equal((await call('DELETE', `/nutrition/logs/${logId}`, undefined, secondToken)).status, 404);
    assert.ok(await FoodLog.findById(logId));
  });

  await check('simultaneous duplicate POSTs create exactly one database record', async () => {
    const body = { ...createBody, clientId: 'parallel-test' };
    const responses = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/nutrition/logs', body, token)));
    assert.ok(responses.every((response) => [200, 201].includes(response.status)));
    assert.equal(new Set(responses.map((response) => response.json.data.log.id)).size, 1);
    assert.equal(await FoodLog.countDocuments({ clientId: body.clientId }), 1);
    const id = responses[0]!.json.data.log.id;
    assert.equal((await call('DELETE', `/nutrition/logs/${id}`, undefined, token)).status, 200);
  });

  await check('target recommendation is read-only against real persistence', async () => {
    const before = (await call('GET', '/nutrition/targets', undefined, token)).json.data.target;
    const setup = { age: 30, gender: 'male', heightCm: 175, weightKg: 70, activityLevel: 'sedentary', goal: 'maintain' };
    const preview = await call('POST', '/nutrition/targets/recommendation', { setup, eligibilityConfirmed: true }, token);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.data.recommendation.target.kcal, 1980);
    assert.deepEqual((await call('GET', '/nutrition/targets', undefined, token)).json.data.target, before);
    const saved = await call('PATCH', '/nutrition/targets', { ...preview.json.data.recommendation.target, setup }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.data.target.setup, setup);
    const summary = await call('GET', '/nutrition/summary?date=2026-08-28', undefined, token);
    assert.deepEqual(summary.json.data.summary.target.setup, setup);
  });

  await check('concurrent partial target patches preserve both changes', async () => {
    const responses = await Promise.all([
      call('PATCH', '/nutrition/targets', { proteinG: 125 }, token),
      call('PATCH', '/nutrition/targets', { fatG: 75 }, token),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    const fetched = await call('GET', '/nutrition/targets', undefined, token);
    assert.equal(fetched.json.data.target.proteinG, 125);
    assert.equal(fetched.json.data.target.fatG, 75);
    assert.equal(fetched.json.data.target.kcal, 1980);
  });

  await check('simultaneous initial target saves retain one target per account', async () => {
    const body = { kcal: 2000, proteinG: 100, carbsG: 250, fatG: 60 };
    const responses = await Promise.all(Array.from({ length: 6 }, () => call('PATCH', '/nutrition/targets', body, secondToken)));
    assert.ok(responses.every((response) => response.status === 200), JSON.stringify(responses.map((response) => response.status)));
    assert.equal(await NutritionTarget.countDocuments(), 2);
  });

  await check('manual calorie validation rejects 800 before persistence', async () => {
    const response = await call('PATCH', '/nutrition/targets', { kcal: 800 }, token);
    assert.equal(response.status, 422);
    assert.equal((await call('GET', '/nutrition/targets', undefined, token)).json.data.target.kcal, 1980);
  });

  // Regression: the Flutter editor previews frozen nutrition, so an unchanged
  // item must not acquire today's composition merely because items were sent.
  await check('resaving unchanged items preserves the nutrition shown in the editor', async () => {
    const response = await call('PATCH', `/nutrition/logs/${logId}`, { items: createBody.items }, token);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.data.log.items[0].snapshot.per100g.kcal, 350);
    assert.equal(response.json.data.log.items[0].macros.kcal, 787.5);
    const resized = await call('PATCH', `/nutrition/logs/${logId}`, {
      items: [{ ...createBody.items[0], grams: 450, quantity: 3 }],
    }, token);
    assert.equal(resized.status, 200, JSON.stringify(resized.json));
    assert.equal(resized.json.data.log.items[0].snapshot.per100g.kcal, 350);
    assert.equal(resized.json.data.log.items[0].macros.kcal, 1575);
    await food.deleteOne();
    const unavailable = await call('PATCH', `/nutrition/logs/${logId}`, {
      items: [{ ...createBody.items[0], grams: 675, quantity: 4.5 }],
    }, token);
    assert.equal(unavailable.status, 200, JSON.stringify(unavailable.json));
    assert.equal(unavailable.json.data.log.items[0].snapshot.per100g.kcal, 350);
    assert.equal(unavailable.json.data.log.items[0].macros.kcal, 2362.5);
  });

  await check('deleting a log removes it from that diary day', async () => {
    const deleted = await call(
      'DELETE',
      `/nutrition/logs/${logId}`,
      undefined,
      token,
    );
    assert.equal(deleted.status, 200);
    const listed = await call(
      'GET',
      '/nutrition/logs?date=2026-08-28',
      undefined,
      token,
    );
    assert.deepEqual(listed.json.data.logs, []);
    const summary = await call('GET', '/nutrition/summary?date=2026-08-28', undefined, token);
    assert.equal(summary.json.data.summary.totals.kcal, 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error(error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});

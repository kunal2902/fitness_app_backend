/** Database-free checks for the tracking Step 3 API contract. */
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/unused';
process.env.JWT_ACCESS_SECRET = 'tracking-selfcheck-access-secret';
process.env.JWT_REFRESH_SECRET = 'tracking-selfcheck-refresh-secret';
process.env.API_PREFIX = '/api/v1';

const [
  { createApp },
  { Activity },
  { HealthDaily },
  { User },
  { activityService, healthService },
  { signAccessToken },
  validators,
  { decodePolyline },
  { renderRouteThumbnail, ROUTE_THUMBNAIL_HEIGHT, ROUTE_THUMBNAIL_WIDTH },
  { default: mongoose },
] = await Promise.all([
  import('../src/app.js'),
  import('../src/models/activity.model.js'),
  import('../src/models/healthDaily.model.js'),
  import('../src/models/user.model.js'),
  import('../src/services/tracking.service.js'),
  import('../src/utils/jwt.js'),
  import('../src/validators/tracking.validator.js'),
  import('../src/tracking/polyline.js'),
  import('../src/tracking/route-thumbnail.js'),
  import('mongoose'),
]);

mongoose.set('bufferCommands', false);

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
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

const activityBody = {
  type: 'run',
  startedAt: '2026-09-12T00:00:00.000Z',
  endedAt: '2026-09-12T00:30:00.000Z',
  durationSec: 1_800,
  movingSec: 1_650,
  distanceM: 5_000,
  elevationGainM: 32.5,
  avgPaceSecPerKm: 330,
  encodedPolyline: '_p~iF~ps|U_ulLnnqC',
  splits: [
    {
      index: 1,
      distanceM: 1_000,
      durationSec: 340,
      movingSec: 330,
      paceSecPerKm: 330,
      isPartial: false,
    },
    {
      index: 2,
      distanceM: 4_000,
      durationSec: 1_310,
      movingSec: 1_200,
      paceSecPerKm: 300,
      isPartial: true,
    },
  ],
  calories: 380,
  avgHr: 151,
  maxHr: 178,
  source: 'app',
  clientId: 'android-session-1',
} as const;

group('Activity validation');

await check('a processed app route passes unchanged in metric units', () => {
  const parsed = validators.createActivitySchema.parse(activityBody);
  assert.equal(parsed.distanceM, 5_000);
  assert.equal(parsed.elevationGainM, 32.5);
  assert.equal(parsed.clientId, 'android-session-1');
});

await check('app recordings require an idempotency clientId', () => {
  const { clientId: _clientId, ...withoutClientId } = activityBody;
  assert.equal(validators.createActivitySchema.safeParse(withoutClientId).success, false);
});

await check('manual activities may omit clientId and route geometry', () => {
  const parsed = validators.createActivitySchema.safeParse({
    ...activityBody,
    source: 'manual',
    encodedPolyline: '',
    splits: [],
    clientId: undefined,
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

await check('malformed route geometry is rejected before persistence', () => {
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      encodedPolyline: '_p~iF~ps|U_ulL',
    }).success,
    false,
  );
});

await check('precision-5 routes decode and render as a bounded PNG', () => {
  const coordinates = decodePolyline(activityBody.encodedPolyline);
  assert.equal(coordinates.length, 2);
  assert.deepEqual(coordinates[0], {
    latitude: 38.5,
    longitude: -120.2,
  });

  const png = renderRouteThumbnail(activityBody.encodedPolyline, activityBody.splits);
  assert.ok(png);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), ROUTE_THUMBNAIL_WIDTH);
  assert.equal(png.readUInt32BE(20), ROUTE_THUMBNAIL_HEIGHT);
  assert.equal(renderRouteThumbnail(''), null);
});

await check('impossible clocks and heart-rate relationships are rejected', () => {
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      movingSec: 1_801,
    }).success,
    false,
  );
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      endedAt: activityBody.startedAt,
    }).success,
    false,
  );
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      avgHr: 180,
      maxHr: 170,
    }).success,
    false,
  );
});

await check('split order and distance totals are checked', () => {
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      splits: [{ ...activityBody.splits[0], index: 2 }],
    }).success,
    false,
  );
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      splits: [{ ...activityBody.splits[0], distanceM: 500 }],
    }).success,
    false,
  );
});

await check('identity and display-only units cannot be injected', () => {
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      userId: '507f1f77bcf86cd799439099',
    }).success,
    false,
  );
  assert.equal(
    validators.createActivitySchema.safeParse({
      ...activityBody,
      distanceMi: 3.1,
    }).success,
    false,
  );
});

await check('activity ranges are paired, ordered and bounded', () => {
  assert.ok(validators.activityRangeQuerySchema.safeParse({}).success);
  assert.equal(
    validators.activityRangeQuerySchema.safeParse({ from: activityBody.startedAt }).success,
    false,
  );
  assert.equal(
    validators.activityRangeQuerySchema.safeParse({
      from: '2026-09-13T00:00:00.000Z',
      to: '2026-09-12T00:00:00.000Z',
    }).success,
    false,
  );
  assert.equal(
    validators.activityRangeQuerySchema.safeParse({
      from: '2025-01-01T00:00:00.000Z',
      to: '2026-09-12T00:00:00.000Z',
    }).success,
    false,
  );
});

group('Health validation');

const healthDay = {
  date: '2026-09-12',
  steps: 8_420,
  activeKcal: 476.5,
  restingHr: 61,
  spo2: 98,
  vo2Max: 44.2,
  weightKg: 74.5,
  source: 'healthconnect',
} as const;

await check('a canonical Health Connect day passes', () => {
  const parsed = validators.healthSyncSchema.parse({ days: [healthDay] });
  assert.equal(parsed.days[0]?.weightKg, 74.5);
});

await check('duplicate dates in one batch are rejected', () => {
  assert.equal(
    validators.healthSyncSchema.safeParse({ days: [healthDay, healthDay] }).success,
    false,
  );
});

await check('syncs are non-empty and capped at 1,000 days', () => {
  assert.equal(validators.healthSyncSchema.safeParse({ days: [] }).success, false);
  assert.equal(
    validators.healthSyncSchema.safeParse({
      days: Array.from({ length: 1_001 }, (_, i) => ({
        ...healthDay,
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      })),
    }).success,
    false,
  );
});

await check('daily health metrics reject invalid dates and ranges', () => {
  assert.equal(
    validators.healthDailyInputSchema.safeParse({ ...healthDay, date: '2026-02-30' }).success,
    false,
  );
  assert.equal(
    validators.healthDailyInputSchema.safeParse({ ...healthDay, spo2: 101 }).success,
    false,
  );
  assert.equal(
    validators.healthDailyInputSchema.safeParse({ ...healthDay, weightKg: -1 }).success,
    false,
  );
});

await check('health reads require a valid, bounded date range', () => {
  assert.ok(
    validators.healthRangeQuerySchema.safeParse({
      from: '2026-09-01',
      to: '2026-09-12',
    }).success,
  );
  assert.equal(validators.healthRangeQuerySchema.safeParse({}).success, false);
  assert.equal(
    validators.healthRangeQuerySchema.safeParse({
      from: '2026-09-12',
      to: '2026-09-01',
    }).success,
    false,
  );
});

group('Persistence indexes');

await check('activity clientId uses the required partial unique index', () => {
  const indexes = Activity.schema.indexes() as Array<
    [Record<string, unknown>, Record<string, unknown>]
  >;
  const index = indexes.find(([, options]) => options.name === 'activity_idempotency');
  assert.ok(index, 'missing activity idempotency index');
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {
    clientId: { $type: 'string' },
  });
});

await check('daily health has one row per user and date', () => {
  const indexes = HealthDaily.schema.indexes() as Array<
    [Record<string, unknown>, Record<string, unknown>]
  >;
  const index = indexes.find(
    ([, options]) => options.name === 'health_daily_per_user_date',
  );
  assert.ok(index, 'missing health daily unique index');
  assert.equal(index[1].unique, true);
});

await check('model validation independently protects app idempotency', async () => {
  const { clientId: _clientId, ...withoutClientId } = activityBody;
  const activity = new Activity({
    userId: '507f1f77bcf86cd799439011',
    ...withoutClientId,
  });
  await assert.rejects(activity.validate(), /clientId is required/);
});

group('Authenticated HTTP contract');

const userId = '507f1f77bcf86cd799439011';
const token = signAccessToken(userId, 'tracking_member');
const account = new User({ _id: userId, username: 'tracking_member' });
const originalFindUser = User.findById;
User.findById = (() => Promise.resolve(account)) as unknown as typeof originalFindUser;

const publicActivity = {
  id: '507f1f77bcf86cd799439012',
  type: 'run' as const,
  startedAt: activityBody.startedAt,
  endedAt: activityBody.endedAt,
  durationSec: activityBody.durationSec,
  movingSec: activityBody.movingSec,
  distanceM: activityBody.distanceM,
  elevationGainM: activityBody.elevationGainM,
  avgPaceSecPerKm: activityBody.avgPaceSecPerKm,
  encodedPolyline: activityBody.encodedPolyline,
  thumbnailUrl: '/uploads/tracking/507f1f77bcf86cd799439012.png',
  splits: activityBody.splits.map((split) => ({ ...split })),
  calories: activityBody.calories,
  avgHr: activityBody.avgHr,
  maxHr: activityBody.maxHr,
  source: 'app' as const,
  clientId: activityBody.clientId,
  createdAt: '2026-09-12T00:31:00.000Z',
  updatedAt: '2026-09-12T00:31:00.000Z',
};
const publicHealthDay = {
  ...healthDay,
  updatedAt: '2026-09-12T01:00:00.000Z',
};

const originals = {
  create: activityService.create,
  listActivities: activityService.list,
  get: activityService.get,
  delete: activityService.delete,
  sync: healthService.sync,
  listHealth: healthService.list,
};

activityService.create = async (_userId, input) => ({
  activity: { ...publicActivity, clientId: input.clientId ?? null },
  isDuplicate: input.clientId === 'retry-1',
});
activityService.list = async () => [publicActivity];
activityService.get = async () => publicActivity;
activityService.delete = async () => undefined;
healthService.sync = async () => [publicHealthDay];
healthService.list = async () => [publicHealthDay];

const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/v1`;

async function call(
  method: string,
  path: string,
  body?: unknown,
  authorization?: string,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    signal: AbortSignal.timeout(5_000),
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
  };
}

try {
  const guarded: Array<[string, string, unknown?]> = [
    ['GET', '/activities'],
    ['POST', '/activities', {}],
    ['GET', `/activities/${publicActivity.id}`],
    ['DELETE', `/activities/${publicActivity.id}`],
    ['POST', '/health/sync', {}],
    ['GET', '/health/daily?from=2026-09-01&to=2026-09-12'],
  ];
  for (const [method, path, body] of guarded) {
    await check(`${method} ${path} requires authentication`, async () => {
      const response = await call(method, path, body);
      assert.equal(response.status, 401, JSON.stringify(response.json));
      assert.equal(response.json.code, 'NO_TOKEN');
    });
  }

  await check('a valid activity uses the standard 201 envelope', async () => {
    const response = await call('POST', '/activities', activityBody, token);
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json.success, true);
    assert.equal(response.json.data.activity.distanceM, 5_000);
    assert.equal(response.json.data.duplicate, false);
  });

  await check('an idempotent retry returns 200 and duplicate true', async () => {
    const response = await call(
      'POST',
      '/activities',
      { ...activityBody, clientId: 'retry-1' },
      token,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.data.duplicate, true);
  });

  await check('activity list, detail and deletion routes are mounted', async () => {
    const listed = await call('GET', '/activities', undefined, token);
    const detail = await call(
      'GET',
      `/activities/${publicActivity.id}`,
      undefined,
      token,
    );
    const deleted = await call(
      'DELETE',
      `/activities/${publicActivity.id}`,
      undefined,
      token,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  });

  await check('authenticated malformed activity input stops at validation', async () => {
    const response = await call(
      'POST',
      '/activities',
      { ...activityBody, movingSec: 99_999 },
      token,
    );
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.ok(response.json.errors.movingSec);
  });

  await check('health sync and range reads use the standard envelope', async () => {
    const synced = await call('POST', '/health/sync', { days: [healthDay] }, token);
    const listed = await call(
      'GET',
      '/health/daily?from=2026-09-01&to=2026-09-12',
      undefined,
      token,
    );
    assert.equal(synced.status, 200, JSON.stringify(synced.json));
    assert.equal(synced.json.data.synced, 1);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.data.days[0].date, healthDay.date);
  });

  await check('health validation runs after authentication and before persistence', async () => {
    const response = await call(
      'POST',
      '/health/sync',
      { days: [{ ...healthDay, steps: -1 }] },
      token,
    );
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.ok(response.json.errors.steps);
  });
} finally {
  User.findById = originalFindUser;
  activityService.create = originals.create;
  activityService.list = originals.listActivities;
  activityService.get = originals.get;
  activityService.delete = originals.delete;
  healthService.sync = originals.sync;
  healthService.list = originals.listHealth;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

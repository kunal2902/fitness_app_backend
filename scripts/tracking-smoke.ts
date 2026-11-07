/** End-to-end tracking Step 3 smoke test against an isolated MongoDB. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

const VALID_PROFILE = {
  gender: 'male',
  heightCm: 178,
  heightUnit: 'cm',
  weightKg: 74.5,
  weightUnit: 'kg',
  goals: ['basic_fitness'],
  maxPullUps: '6_10',
  maxPushUps: '11_20',
  maxSquats: '21_30',
  maxDips: 'lt_9',
  fitnessLevel: 'beginner',
};

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void>) {
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

async function main() {
  const smokeUploads = path.resolve(
    process.cwd(),
    'tmp',
    'tracking-smoke-uploads',
  );
  assert.ok(smokeUploads.startsWith(`${path.resolve(process.cwd())}${path.sep}`));
  await fs.rm(smokeUploads, { recursive: true, force: true });

  const host = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  process.env.MONGO_URI = `${host.replace(/\/$/, '')}/fitness_app_tracking_test`;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'tracking-smoke-access-secret';
  process.env.JWT_REFRESH_SECRET = 'tracking-smoke-refresh-secret';
  process.env.PORT = '0';
  process.env.UPLOAD_DIR = smokeUploads;

  const [{ createApp }, { Activity }, { HealthDaily }] = await Promise.all([
    import('../src/app.js'),
    import('../src/models/activity.model.js'),
    import('../src/models/healthDaily.model.js'),
  ]);

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5_000,
  });
  await mongoose.connection.dropDatabase();
  await Promise.all([Activity.syncIndexes(), HealthDaily.syncIndexes()]);

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/api/v1`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(5_000),
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
  }

  async function signup(username: string, email: string): Promise<string> {
    const response = await call('POST', '/auth/signup', {
      username,
      fullName: `${username} member`,
      email,
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    return response.json.data.tokens.accessToken as string;
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
        distanceM: 5_000,
        durationSec: 1_650,
        movingSec: 1_650,
        paceSecPerKm: 330,
        isPartial: false,
      },
    ],
    calories: 380,
    avgHr: 151,
    maxHr: 178,
    source: 'app',
    clientId: 'device-run-1',
  };

  let firstToken = '';
  let secondToken = '';
  let activityId = '';
  let firstThumbnailUrl = '';

  console.log('\nTracking API smoke\n');

  try {
    await check('two real accounts authenticate independently', async () => {
      firstToken = await signup('tracking_first', 'tracking-first@example.com');
      secondToken = await signup('tracking_second', 'tracking-second@example.com');
      assert.ok(firstToken && secondToken);
    });

    await check('an app route is created in canonical metric units', async () => {
      const response = await call('POST', '/activities', activityBody, firstToken);
      assert.equal(response.status, 201, JSON.stringify(response.json));
      activityId = response.json.data.activity.id;
      firstThumbnailUrl = response.json.data.activity.thumbnailUrl;
      assert.equal(response.json.data.activity.distanceM, 5_000);
      assert.equal(response.json.data.activity.elevationGainM, 32.5);
      assert.equal(response.json.data.activity.clientId, 'device-run-1');
      assert.match(
        firstThumbnailUrl,
        /^\/uploads\/tracking\/[a-f0-9]{24}-[a-f0-9]{32}\.png$/,
      );
    });

    await check('the static route thumbnail is a cacheable 640x360 PNG', async () => {
      const response = await fetch(`${origin}${firstThumbnailUrl}`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^image\/png/);
      assert.match(response.headers.get('cache-control') ?? '', /max-age=604800/);
      const png = Buffer.from(await response.arrayBuffer());
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), 640);
      assert.equal(png.readUInt32BE(20), 360);
    });

    await check('retrying clientId returns the original route', async () => {
      const response = await call('POST', '/activities', activityBody, firstToken);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.data.duplicate, true);
      assert.equal(response.json.data.activity.id, activityId);
      assert.equal(response.json.data.activity.thumbnailUrl, firstThumbnailUrl);
      assert.equal(await Activity.countDocuments(), 1);
    });

    await check('activity list and detail are scoped to the owner', async () => {
      const ownList = await call(
        'GET',
        '/activities?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-30T23%3A59%3A59.999Z',
        undefined,
        firstToken,
      );
      const ownDetail = await call(
        'GET',
        `/activities/${activityId}`,
        undefined,
        firstToken,
      );
      const otherList = await call('GET', '/activities', undefined, secondToken);
      const otherDetail = await call(
        'GET',
        `/activities/${activityId}`,
        undefined,
        secondToken,
      );
      assert.equal(ownList.json.data.activities.length, 1);
      assert.equal(ownDetail.status, 200);
      assert.deepEqual(otherList.json.data.activities, []);
      assert.equal(otherDetail.status, 404);
    });

    await check('clientId uniqueness is per user, not global', async () => {
      const response = await call('POST', '/activities', activityBody, secondToken);
      assert.equal(response.status, 201, JSON.stringify(response.json));
      assert.notEqual(response.json.data.activity.id, activityId);
      assert.equal(await Activity.countDocuments(), 2);
    });

    await check('simultaneous retries create exactly one activity', async () => {
      const body = { ...activityBody, clientId: 'parallel-run-1' };
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => call('POST', '/activities', body, firstToken)),
      );
      assert.ok(
        responses.every((response) => [200, 201].includes(response.status)),
        JSON.stringify(responses.map((response) => response.status)),
      );
      assert.equal(
        new Set(responses.map((response) => response.json.data.activity.id)).size,
        1,
      );
      assert.equal(await Activity.countDocuments({ clientId: 'parallel-run-1' }), 1);
    });

    await check('health sync upserts a day and preserves omitted optional data', async () => {
      const first = await call(
        'POST',
        '/health/sync',
        {
          days: [
            {
              date: '2026-09-12',
              steps: 8_420,
              activeKcal: 476.5,
              restingHr: 61,
              spo2: 98,
              weightKg: 74.5,
              source: 'healthconnect',
            },
          ],
        },
        firstToken,
      );
      const retry = await call(
        'POST',
        '/health/sync',
        {
          days: [
            {
              date: '2026-09-12',
              steps: 9_001,
              activeKcal: 510,
              source: 'healthconnect',
            },
          ],
        },
        firstToken,
      );
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(retry.status, 200, JSON.stringify(retry.json));
      assert.equal(retry.json.data.days[0].steps, 9_001);
      assert.equal(retry.json.data.days[0].restingHr, 61);
      assert.equal(await HealthDaily.countDocuments(), 1);
    });

    await check('nullable health metrics can be explicitly cleared', async () => {
      const response = await call(
        'POST',
        '/health/sync',
        {
          days: [
            {
              date: '2026-09-12',
              steps: 9_001,
              activeKcal: 510,
              restingHr: null,
              source: 'healthconnect',
            },
          ],
        },
        firstToken,
      );
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.data.days[0].restingHr, null);
    });

    await check('daily health is private to its account', async () => {
      const own = await call(
        'GET',
        '/health/daily?from=2026-09-01&to=2026-09-12',
        undefined,
        firstToken,
      );
      const other = await call(
        'GET',
        '/health/daily?from=2026-09-01&to=2026-09-12',
        undefined,
        secondToken,
      );
      assert.equal(own.json.data.days.length, 1);
      assert.deepEqual(other.json.data.days, []);
    });

    await check('only the owner can delete an activity', async () => {
      const refused = await call(
        'DELETE',
        `/activities/${activityId}`,
        undefined,
        secondToken,
      );
      assert.equal(refused.status, 404);
      assert.ok(await Activity.findById(activityId));

      const deleted = await call(
        'DELETE',
        `/activities/${activityId}`,
        undefined,
        firstToken,
      );
      assert.equal(deleted.status, 200);
      assert.equal(await Activity.findById(activityId), null);
      const thumbnailFile = path.join(
        smokeUploads,
        'tracking',
        path.basename(firstThumbnailUrl),
      );
      await assert.rejects(fs.access(thumbnailFile));
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await fs.rm(smokeUploads, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (error: unknown) => {
  console.error(error);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  process.exitCode = 1;
});

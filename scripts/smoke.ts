/**
 * End-to-end smoke test for the auth flow.
 *
 * Mounts the real Express app against a throwaway database and walks the
 * exact sequence the Flutter client performs: signup with the nine
 * onboarding answers → /me → refresh → login → duplicate signup → bad
 * password → validation failure.
 *
 * Requires a running MongoDB. It writes to a separate `fitness_app_test`
 * database and drops it at the end, so your dev data is never touched.
 *
 * Run with:  npm run smoke
 */
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

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

const VALID_PROFILE = {
  gender: 'male',
  heightCm: 178,
  heightUnit: 'cm',
  weightKg: 74.5,
  weightUnit: 'kg',
  goals: ['build_strength', 'learn_calisthenics'],
  maxPullUps: '11_15',
  maxPushUps: '21_30',
  maxSquats: '31_40',
  maxDips: '9_15',
  fitnessLevel: 'intermediate',
};

async function main() {
  const host = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  process.env.MONGO_URI = `${host.replace(/\/$/, '')}/fitness_app_test`;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.PORT = '0';

  // Imported after env is set so config/env.ts reads the test values.
  const { createApp } = await import('../src/app.js');
  await mongoose.connect(process.env.MONGO_URI);
  // Start from a clean slate even if a previous run was interrupted.
  await mongoose.connection.dropDatabase();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1`;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  console.log('\nAuth flow\n');

  let accessToken = '';
  let refreshToken = '';
  let userId = '';

  await check('health reports a connected database', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.database, 'connected');
  });

  await check('username is available before signup', async () => {
    const res = await call('GET', '/auth/check-availability?username=iron_kunal');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.usernameAvailable, true);
  });

  await check('signup creates the user and returns a token pair', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'Iron_Kunal',
      fullName: 'Kunal Bhardwaj',
      email: 'Kunal@Example.COM',
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(res.json.data.tokens.accessToken, 'no access token');
    assert.ok(res.json.data.tokens.refreshToken, 'no refresh token');

    accessToken = res.json.data.tokens.accessToken;
    refreshToken = res.json.data.tokens.refreshToken;
    userId = res.json.data.user.id;

    assert.ok(userId, 'user.id missing (transform did not run)');
    assert.equal(res.json.data.user.username, 'iron_kunal', 'username not lowercased');
    assert.equal(res.json.data.user.email, 'kunal@example.com', 'email not lowercased');
  });

  await check('password hash never leaves the server', async () => {
    const res = await call('GET', '/auth/me', undefined, accessToken);
    const raw = JSON.stringify(res.json);
    assert.ok(!raw.includes('passwordHash'), 'passwordHash leaked in /me');
    assert.ok(!raw.includes('strongpass1'), 'plaintext password leaked');
  });

  await check('the stored password is a bcrypt hash, not plaintext', async () => {
    const doc = await mongoose.connection
      .collection('users')
      .findOne({ _id: new mongoose.Types.ObjectId(userId) });
    assert.ok(doc, 'user not found in the database');
    assert.notEqual(doc.passwordHash, 'strongpass1');
    assert.match(doc.passwordHash as string, /^\$2[aby]\$/);
  });

  await check('the nine onboarding answers round-trip intact', async () => {
    const res = await call('GET', '/auth/me', undefined, accessToken);
    const profile = res.json.data.user.fitnessProfile;
    assert.equal(profile.gender, 'male');
    assert.equal(profile.heightCm, 178);
    assert.equal(profile.weightKg, 74.5);
    assert.deepEqual(profile.goals, ['build_strength', 'learn_calisthenics']);
    assert.equal(profile.maxPullUps, '11_15');
    assert.equal(profile.maxPushUps, '21_30');
    assert.equal(profile.maxSquats, '31_40');
    assert.equal(profile.maxDips, '9_15');
    assert.equal(profile.fitnessLevel, 'intermediate');
  });

  await check('/me rejects a missing token', async () => {
    const res = await call('GET', '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.json.success, false);
  });

  await check('/me rejects a garbage token', async () => {
    const res = await call('GET', '/auth/me', undefined, 'not-a-jwt');
    assert.equal(res.status, 401);
  });

  await check('username is no longer available', async () => {
    const res = await call('GET', '/auth/check-availability?username=iron_kunal');
    assert.equal(res.json.data.usernameAvailable, false);
  });

  await check('duplicate signup returns 409 with a field error', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'iron_kunal',
      fullName: 'Someone Else',
      email: 'other@example.com',
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.errors.username, 'That username is taken');
  });

  await check('invalid payload returns 422 with per-field messages', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'x',
      fullName: 'A',
      email: 'nope',
      password: 'short',
      fitnessProfile: { ...VALID_PROFILE, gender: 'other' },
    });
    assert.equal(res.status, 422);
    assert.ok(res.json.errors.username, 'no username error');
    assert.ok(res.json.errors.email, 'no email error');
    assert.ok(res.json.errors.password, 'no password error');
  });

  await check('out-of-range height is rejected', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'tallguy',
      fullName: 'Tall Guy',
      email: 'tall@example.com',
      password: 'strongpass1',
      fitnessProfile: { ...VALID_PROFILE, heightCm: 400 },
    });
    assert.equal(res.status, 422);
  });

  await check('more than three goals is rejected', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'greedy',
      fullName: 'Greedy Goals',
      email: 'greedy@example.com',
      password: 'strongpass1',
      fitnessProfile: {
        ...VALID_PROFILE,
        goals: ['yoga', 'stretching', 'lose_fat', 'build_muscle'],
      },
    });
    assert.equal(res.status, 422);
  });

  await check('login works with the email', async () => {
    const res = await call('POST', '/auth/login', {
      identifier: 'KUNAL@example.com',
      password: 'strongpass1',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.data.tokens.accessToken);
  });

  await check('login works with the username', async () => {
    const res = await call('POST', '/auth/login', {
      identifier: 'iron_kunal',
      password: 'strongpass1',
    });
    assert.equal(res.status, 200);
  });

  await check('login rejects a wrong password without leaking which', async () => {
    const res = await call('POST', '/auth/login', {
      identifier: 'iron_kunal',
      password: 'wrongpass1',
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.message, 'Incorrect username or password');
  });

  await check('login on an unknown account gives the same message', async () => {
    const res = await call('POST', '/auth/login', {
      identifier: 'ghost',
      password: 'strongpass1',
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.message, 'Incorrect username or password');
  });

  let rotatedRefresh = '';

  await check('refresh rotates the token pair', async () => {
    const res = await call('POST', '/auth/refresh', { refreshToken });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    rotatedRefresh = res.json.data.tokens.refreshToken;
    assert.notEqual(rotatedRefresh, refreshToken, 'refresh token was not rotated');
  });

  await check('reusing a rotated refresh token is rejected', async () => {
    const res = await call('POST', '/auth/refresh', { refreshToken });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'REFRESH_REUSED');
  });

  await check('reuse detection revoked the whole chain', async () => {
    const res = await call('POST', '/auth/refresh', {
      refreshToken: rotatedRefresh,
    });
    assert.equal(res.status, 401);
  });

  await check('logout is idempotent', async () => {
    const fresh = await call('POST', '/auth/login', {
      identifier: 'iron_kunal',
      password: 'strongpass1',
    });
    const token = fresh.json.data.tokens.refreshToken;

    const first = await call('POST', '/auth/logout', { refreshToken: token });
    assert.equal(first.status, 200);
    const second = await call('POST', '/auth/logout', { refreshToken: token });
    assert.equal(second.status, 200);

    const afterLogout = await call('POST', '/auth/refresh', {
      refreshToken: token,
    });
    assert.equal(afterLogout.status, 401, 'revoked token still refreshes');
  });

  await check('unknown route returns a 404 envelope', async () => {
    const res = await call('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
  });

  server.close();
  // Leave nothing behind.
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Database-free checks.
 *
 * Everything here runs without MongoDB: token signing and verification,
 * the Zod schemas that guard `/auth/signup`, password hashing, and the
 * HTTP surface that returns before any query is issued (routing, 404s,
 * validation rejections, auth guards).
 *
 * Run with:  npm run selfcheck
 */
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/unused';
process.env.JWT_ACCESS_SECRET = 'selfcheck-access-secret';
process.env.JWT_REFRESH_SECRET = 'selfcheck-refresh-secret';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.BCRYPT_ROUNDS = '4'; // fast, test-only

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

function group(title: string) {
  console.log(`\n${title}\n`);
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
  const bcrypt = (await import('bcrypt')).default;
  const {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    durationToMs,
  } = await import('../src/utils/jwt.js');
  const { signupSchema, loginSchema, availabilitySchema } = await import(
    '../src/validators/auth.validator.js'
  );
  const {
    GENDERS,
    FITNESS_GOALS,
    PULLUP_RANGES,
    PUSHUP_RANGES,
    SQUAT_RANGES,
    DIP_RANGES,
    FITNESS_LEVELS,
  } = await import('../src/models/user.model.js');
  const { createApp } = await import('../src/app.js');

  // -------------------------------------------------------------------------
  group('Tokens');

  await check('an access token round-trips its claims', () => {
    const token = signAccessToken('507f1f77bcf86cd799439011', 'iron_kunal');
    const payload = verifyAccessToken(token);
    assert.equal(payload.sub, '507f1f77bcf86cd799439011');
    assert.equal(payload.username, 'iron_kunal');
    assert.equal(payload.type, 'access');
  });

  await check('a refresh token carries a jti', () => {
    const token = signRefreshToken('507f1f77bcf86cd799439011', 'jti-123');
    const payload = verifyRefreshToken(token);
    assert.equal(payload.jti, 'jti-123');
    assert.equal(payload.type, 'refresh');
  });

  await check('an access token is not accepted as a refresh token', () => {
    const token = signAccessToken('507f1f77bcf86cd799439011', 'iron_kunal');
    assert.throws(() => verifyRefreshToken(token));
  });

  await check('a refresh token is not accepted as an access token', () => {
    const token = signRefreshToken('507f1f77bcf86cd799439011', 'jti-123');
    assert.throws(() => verifyAccessToken(token));
  });

  await check('a tampered token is rejected', () => {
    const token = signAccessToken('507f1f77bcf86cd799439011', 'iron_kunal');
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'x'.repeat(20)}`;
    assert.throws(() => verifyAccessToken(forged));
  });

  await check('durations parse to the right milliseconds', () => {
    assert.equal(durationToMs('15m'), 900_000);
    assert.equal(durationToMs('30d'), 2_592_000_000);
    assert.equal(durationToMs('1h'), 3_600_000);
    assert.equal(durationToMs('nonsense'), 0);
  });

  // -------------------------------------------------------------------------
  group('Passwords');

  await check('bcrypt hashes verify and are salted', async () => {
    const a = await bcrypt.hash('strongpass1', 4);
    const b = await bcrypt.hash('strongpass1', 4);
    assert.notEqual(a, b, 'identical hashes means no salt');
    assert.ok(await bcrypt.compare('strongpass1', a));
    assert.ok(!(await bcrypt.compare('wrongpass1', a)));
  });

  // -------------------------------------------------------------------------
  group('Signup validation');

  await check('a well-formed payload passes', () => {
    const result = signupSchema.safeParse({
      username: 'iron_kunal',
      fullName: 'Kunal Bhardwaj',
      email: 'kunal@example.com',
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  await check('username and email are normalised to lowercase', () => {
    const result = signupSchema.parse({
      username: 'Iron_Kunal',
      fullName: '  Kunal Bhardwaj  ',
      email: 'Kunal@Example.COM',
      password: 'strongpass1',
      fitnessProfile: VALID_PROFILE,
    });
    assert.equal(result.username, 'iron_kunal');
    assert.equal(result.email, 'kunal@example.com');
    assert.equal(result.fullName, 'Kunal Bhardwaj');
  });

  const badUsernames: Array<[string, string]> = [
    ['ab', 'too short'],
    ['a'.repeat(21), 'too long'],
    ['_leading', 'starts with underscore'],
    ['has space', 'contains a space'],
    ['trailing_', 'ends with underscore'],
    ['double..dot', 'repeated dots'],
    ['emoji🔥', 'non-ascii'],
  ];
  for (const [value, why] of badUsernames) {
    await check(`username rejected: ${why}`, () => {
      const result = signupSchema.safeParse({
        username: value,
        fullName: 'Kunal Bhardwaj',
        email: 'kunal@example.com',
        password: 'strongpass1',
        fitnessProfile: VALID_PROFILE,
      });
      assert.ok(!result.success, `"${value}" should have been rejected`);
    });
  }

  const badPasswords: Array<[string, string]> = [
    ['short1', 'under 8 characters'],
    ['alllettersonly', 'no digit'],
    ['12345678', 'no letter'],
  ];
  for (const [value, why] of badPasswords) {
    await check(`password rejected: ${why}`, () => {
      const result = signupSchema.safeParse({
        username: 'iron_kunal',
        fullName: 'Kunal Bhardwaj',
        email: 'kunal@example.com',
        password: value,
        fitnessProfile: VALID_PROFILE,
      });
      assert.ok(!result.success, `"${value}" should have been rejected`);
    });
  }

  await check('a 64-character password is still accepted', () => {
    const result = signupSchema.safeParse({
      username: 'iron_kunal',
      fullName: 'Kunal Bhardwaj',
      email: 'kunal@example.com',
      password: `${'a'.repeat(63)}1`,
      fitnessProfile: VALID_PROFILE,
    });
    assert.ok(result.success);
  });

  // -------------------------------------------------------------------------
  group('Fitness profile validation');

  const profileCases: Array<[Record<string, unknown>, string]> = [
    [{ gender: 'other' }, 'unknown gender'],
    [{ heightCm: 119 }, 'height below the floor'],
    [{ heightCm: 231 }, 'height above the ceiling'],
    [{ weightKg: 29 }, 'weight below the floor'],
    [{ weightKg: 201 }, 'weight above the ceiling'],
    [{ goals: [] }, 'no goals'],
    [{ goals: ['yoga', 'stretching', 'lose_fat', 'build_muscle'] }, 'four goals'],
    [{ goals: ['not_a_goal'] }, 'unknown goal'],
    [{ maxPullUps: '5_9' }, 'unknown pull-up range'],
    [{ maxPushUps: 'lt_6' }, 'a pull-up range used for push-ups'],
    [{ maxSquats: '11_15' }, 'a pull-up range used for squats'],
    [{ maxDips: 'gt_30' }, 'a push-up range used for dips'],
    [{ fitnessLevel: 'expert' }, 'unknown fitness level'],
  ];
  for (const [patch, why] of profileCases) {
    await check(`profile rejected: ${why}`, () => {
      const result = signupSchema.safeParse({
        username: 'iron_kunal',
        fullName: 'Kunal Bhardwaj',
        email: 'kunal@example.com',
        password: 'strongpass1',
        fitnessProfile: { ...VALID_PROFILE, ...patch },
      });
      assert.ok(!result.success, `${why} should have been rejected`);
    });
  }

  await check('every enum value the client can send is accepted', () => {
    for (const gender of GENDERS) {
      for (const level of FITNESS_LEVELS) {
        const result = signupSchema.safeParse({
          username: 'iron_kunal',
          fullName: 'Kunal Bhardwaj',
          email: 'kunal@example.com',
          password: 'strongpass1',
          fitnessProfile: { ...VALID_PROFILE, gender, fitnessLevel: level },
        });
        assert.ok(result.success, `${gender}/${level} rejected`);
      }
    }
    for (const goal of FITNESS_GOALS) {
      const result = signupSchema.safeParse({
        username: 'iron_kunal',
        fullName: 'Kunal Bhardwaj',
        email: 'kunal@example.com',
        password: 'strongpass1',
        fitnessProfile: { ...VALID_PROFILE, goals: [goal] },
      });
      assert.ok(result.success, `goal ${goal} rejected`);
    }
    const rangeSets: Array<[string, readonly string[]]> = [
      ['maxPullUps', PULLUP_RANGES],
      ['maxPushUps', PUSHUP_RANGES],
      ['maxSquats', SQUAT_RANGES],
      ['maxDips', DIP_RANGES],
    ];
    for (const [field, values] of rangeSets) {
      for (const value of values) {
        const result = signupSchema.safeParse({
          username: 'iron_kunal',
          fullName: 'Kunal Bhardwaj',
          email: 'kunal@example.com',
          password: 'strongpass1',
          fitnessProfile: { ...VALID_PROFILE, [field]: value },
        });
        assert.ok(result.success, `${field}=${value} rejected`);
      }
    }
  });

  // -------------------------------------------------------------------------
  group('Other schemas');

  await check('login requires both fields', () => {
    assert.ok(!loginSchema.safeParse({ identifier: '', password: 'x' }).success);
    assert.ok(!loginSchema.safeParse({ identifier: 'a', password: '' }).success);
    assert.ok(loginSchema.safeParse({ identifier: 'a', password: 'x' }).success);
  });

  await check('availability needs at least one of username or email', () => {
    assert.ok(!availabilitySchema.safeParse({}).success);
    assert.ok(availabilitySchema.safeParse({ username: 'a' }).success);
    assert.ok(availabilitySchema.safeParse({ email: 'a@b.com' }).success);
  });

  // -------------------------------------------------------------------------
  group('HTTP surface (no database needed)');

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
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: text ? (JSON.parse(text) as Record<string, any>) : {},
    };
  };

  await check('the health route answers', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'ok');
    // No DB in this run, so it should say so rather than claim connected.
    assert.notEqual(res.json.data.database, 'connected');
  });

  await check('an unknown route returns the error envelope', async () => {
    const res = await call('GET', '/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
    assert.equal(res.json.code, 'NOT_FOUND');
  });

  await check('signup validation rejects before touching the database', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'x',
      fullName: 'A',
      email: 'not-an-email',
      password: 'short',
      fitnessProfile: { ...VALID_PROFILE, gender: 'other' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'VALIDATION_ERROR');
    assert.ok(res.json.errors.username, 'missing username error');
    assert.ok(res.json.errors.email, 'missing email error');
    assert.ok(res.json.errors.password, 'missing password error');
    assert.ok(res.json.errors.fullName, 'missing fullName error');
  });

  await check('nested profile errors are keyed for the client form', async () => {
    const res = await call('POST', '/auth/signup', {
      username: 'iron_kunal',
      fullName: 'Kunal Bhardwaj',
      email: 'kunal@example.com',
      password: 'strongpass1',
      fitnessProfile: { ...VALID_PROFILE, heightCm: 999 },
    });
    assert.equal(res.status, 422);
    assert.ok(
      Object.keys(res.json.errors).some((k) => k.includes('heightCm')),
      `expected a heightCm error, got ${JSON.stringify(res.json.errors)}`,
    );
  });

  await check('a malformed JSON body returns 400, not 500', async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, false);
  });

  await check('/auth/me without a token is 401', async () => {
    const res = await call('GET', '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'NO_TOKEN');
  });

  await check('/auth/me with a malformed token is 401', async () => {
    const res = await call('GET', '/auth/me', undefined, 'garbage');
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'INVALID_TOKEN');
  });

  await check('/auth/me with a foreign-signed token is 401', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign(
      { username: 'attacker', type: 'access' },
      'a-different-secret',
      { subject: '507f1f77bcf86cd799439011', issuer: 'fitness-app' },
    );
    const res = await call('GET', '/auth/me', undefined, forged);
    assert.equal(res.status, 401);
  });

  await check('refresh without a token is a 422, not a crash', async () => {
    const res = await call('POST', '/auth/refresh', {});
    assert.equal(res.status, 422);
  });

  await check('availability with no parameters is rejected', async () => {
    const res = await call('GET', '/auth/check-availability');
    assert.equal(res.status, 422);
  });

  await check('security headers are present', async () => {
    const res = await call('GET', '/health');
    assert.ok(
      res.headers.get('x-content-type-options'),
      'helmet is not applied',
    );
  });

  await check('rate limit headers are advertised', async () => {
    const res = await call('GET', '/health');
    assert.ok(
      res.headers.get('ratelimit') ?? res.headers.get('ratelimit-limit'),
      'no rate limit headers',
    );
  });

  server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

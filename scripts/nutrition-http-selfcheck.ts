/** Real HTTP/auth/validation, with only the account lookup replaced. No DB I/O. */
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/unused';
process.env.JWT_ACCESS_SECRET = 'step8-http-access-secret';
process.env.JWT_REFRESH_SECRET = 'step8-http-refresh-secret';
process.env.NUTRITION_TARGET_POLICY_APPROVAL = '';
process.env.API_PREFIX = '/api/v1';

const [{ createApp }, { User }, { signAccessToken }, { default: mongoose }] = await Promise.all([
  import('../src/app.js'), import('../src/models/user.model.js'),
  import('../src/utils/jwt.js'), import('mongoose'),
]);
mongoose.set('bufferCommands', false);
const originalFind = User.findById;
const userId = '507f1f77bcf86cd799439011';
const token = signAccessToken(userId, 'verification_member');
const account = new User({ _id: userId, username: 'verification_member' });
User.findById = ((id: unknown) => Promise.resolve(String(id) === userId ? account : null)) as unknown as typeof originalFind;
const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/v1`;
const item = { foodId: userId, grams: 150, quantity: 1, unitLabel: '1 katori' };
const log = { date: '2026-09-04', mealType: 'breakfast', items: [item] };
const setup = { age: 30, gender: 'male', heightCm: 175, weightKg: 70, activityLevel: 'sedentary', goal: 'maintain' };
let passed = 0;
let failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${(error as Error).message}`); }
}
async function call(method: string, path: string, body?: unknown, accessToken = token) {
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(5_000),
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}
try {
  const invalid: Array<[string, string, unknown?]> = [
    ['GET', '/foods/search'], ['GET', '/foods/search?q=%20'],
    ['GET', '/foods/search?q=poha&limit=51'], ['GET', '/foods/search?q=poha&limit=abc'],
    ['GET', '/foods/not-an-id'], ['GET', '/nutrition/logs'],
    ['GET', '/nutrition/logs?date=2026-02-30'], ['GET', '/nutrition/summary?date=bad'],
    ['POST', '/nutrition/logs', {}], ['POST', '/nutrition/logs', { ...log, items: [] }],
    ['POST', '/nutrition/logs', { ...log, mealType: 'brunch' }],
    ['POST', '/nutrition/logs', { ...log, items: [{ ...item, grams: 0 }] }],
    ['POST', '/nutrition/logs', { ...log, items: [{ ...item, quantity: -1 }] }],
    ['POST', '/nutrition/logs', { ...log, items: [{ ...item, foodId: 'bad' }] }],
    ['PATCH', `/nutrition/logs/${userId}`, {}], ['PATCH', '/nutrition/logs/bad', { notes: 'x' }],
    ['DELETE', '/nutrition/logs/bad'], ['PATCH', '/nutrition/targets', {}],
    ['PATCH', '/nutrition/targets', { kcal: 800 }], ['PATCH', '/nutrition/targets', { kcal: 10001 }],
    ['PATCH', '/nutrition/targets', { proteinG: -1 }], ['PATCH', '/nutrition/targets', { carbsG: 1501 }],
    ['PATCH', '/nutrition/targets', { fatG: 501 }],
    ['POST', '/nutrition/targets/recommendation', { setup }],
    ['POST', '/nutrition/targets/recommendation', { setup: { ...setup, age: 17 }, eligibilityConfirmed: true }],
    ['POST', '/nutrition/targets/recommendation', { setup: { ...setup, activityLevel: 'advanced' }, eligibilityConfirmed: true }],
  ];
  for (const [index, [method, path, body]] of invalid.entries()) {
    await check(`validation case ${index + 1}: ${method} ${path}`, async () => {
      const response = await call(method, path, body);
      assert.equal(response.status, 422, JSON.stringify(response.json));
      assert.equal(response.json.success, false);
      assert.ok(Object.keys(response.json.errors ?? {}).length > 0);
    });
  }
  await check('signed-in estimate has the exact client envelope and no DB write', async () => {
    const response = await call('POST', '/nutrition/targets/recommendation', { setup, eligibilityConfirmed: true });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const preview = response.json.data.recommendation;
    assert.deepEqual(preview.setup, setup);
    assert.deepEqual(preview.target, { kcal: 1980, proteinG: 112, carbsG: 234.5, fatG: 66 });
    assert.equal(preview.reviewed, false);
    assert.ok(preview.warnings.length > 0);
  });
  await check('deleted accounts cannot access the calculator', async () => {
    const otherToken = signAccessToken('507f1f77bcf86cd799439012', 'removed_member');
    const response = await call('POST', '/nutrition/targets/recommendation', { setup, eligibilityConfirmed: true }, otherToken);
    assert.equal(response.status, 401);
    assert.equal(response.json.code, 'USER_GONE');
  });
} finally {
  User.findById = originalFind;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;

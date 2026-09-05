/** Read-only Step 8 audit of local datasets. Never publishes or seeds data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rightsManifestSchema } from '../src/nutrition/food.schema.js';
import { readCsvRows, readXlsxRows } from '../src/nutrition/food-source-reader.js';
import { transformRows } from '../src/nutrition/food-transform.js';

const [ifctPath, indbPath] = process.argv.slice(2);
if (!ifctPath || !indbPath) {
  throw new Error('Usage: npm run verify:catalogue -- path/to/ifct.csv path/to/indb.xlsx');
}
const rights = rightsManifestSchema.parse(JSON.parse(await readFile(new URL('../data/nutrition/rights-manifest.example.json', import.meta.url), 'utf8')));
const ifctRows = await readCsvRows(ifctPath);
const indbRows = await readXlsxRows(indbPath);
const ifct = transformRows('ifct2017', ifctRows, rights.sources.ifct2017);
const indb = transformRows('indb', indbRows, rights.sources.indb);
let passed = 0;
let failed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${(error as Error).message}`); }
}
check('all 542 IFCT rows transform without silent loss', () => {
  assert.equal(ifctRows.length, 542);
  assert.deepEqual(ifct.errors, []);
  assert.equal(ifct.foods.length, ifctRows.length);
});
check('every INDB row transforms without silent loss', () => {
  assert.ok(indbRows.length >= 1014);
  assert.deepEqual(indb.errors, []);
  assert.equal(indb.foods.length, indbRows.length);
});
const oils = ifctRows.filter((row) => /edible oils and fats/i.test(String(row.grup)));
check('all 14 real oils use auditable Atwater repair', () => {
  assert.equal(oils.length, 14);
  for (const row of oils) {
    const food = ifct.foods.find((candidate) => candidate.externalId === `ifct:${String(row.code).toUpperCase()}`);
    assert.ok(food, String(row.code));
    assert.equal(food.energySource, 'atwater_repair', food.externalId);
    const atwater = Number(row.protcnt) * 4 + Number(row.choavldf) * 4 + Number(row.fatce) * 9;
    assert.ok(food.per100g.kcal > 0, food.externalId);
    assert.ok(Math.abs(food.per100g.kcal - atwater) < 0.000051, food.externalId);
  }
});
check('source-energy records match kJ divided by 4.184', () => {
  const foods = ifct.foods.filter((food) => food.energySource === 'source_kj');
  assert.ok(foods.length > 0);
  for (const food of foods) {
    const row = ifctRows.find((candidate) => `ifct:${String(candidate.code).toUpperCase()}` === food.externalId);
    assert.ok(Math.abs(food.per100g.kcal - Number(row?.enerc) / 4.184) < 0.000051, food.externalId);
  }
});
check('poha and aval resolve to real Rice flakes aliases', () => {
  for (const query of ['poha', 'aval']) {
    assert.ok(ifct.foods.some((food) => food.externalId === 'ifct:A011' && /rice,? flakes/i.test(food.name) && food.searchTerms.includes(query)), query);
  }
});
const foods = [...ifct.foods, ...indb.foods];
check('combined IDs are unique and every food retains provenance and 100 g', () => {
  assert.equal(new Set(foods.map((food) => food.externalId)).size, foods.length);
  for (const food of foods) {
    assert.ok(food.source && food.licence && food.sourceVersion, food.externalId);
    assert.equal(food.servings.filter((serving) => serving.isDefault).length, 1, food.externalId);
    assert.ok(food.servings.some((serving) => serving.label === '100 g' && serving.grams === 100), food.externalId);
  }
});
check('transforming the same datasets twice is deterministic', () => {
  assert.deepEqual(transformRows('ifct2017', ifctRows, rights.sources.ifct2017), ifct);
  assert.deepEqual(transformRows('indb', indbRows, rights.sources.indb), indb);
});
for (const file of [ifctPath, indbPath]) {
  console.log(`SHA256 ${file}: ${createHash('sha256').update(await readFile(file)).digest('hex')}`);
}
console.log(JSON.stringify({ ifct: ifct.foods.length, indb: indb.foods.length,
  repaired: ifct.foods.filter((food) => food.energySource === 'atwater_repair').length,
  aliases: ifct.foods.reduce((sum, food) => sum + food.aliases.length, 0),
  sourceServings: indb.foods.filter((food) => food.servings.some((serving) => serving.origin === 'source_dataset')).length,
}));
console.log(`\n${passed} passed, ${failed} failed. Read-only audit; no release approval or import.\n`);
process.exitCode = failed ? 1 : 0;

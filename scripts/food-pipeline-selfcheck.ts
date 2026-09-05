/** Database-free regression checks for the nutrition data pipeline. */
import assert from 'node:assert/strict';

import { normalizedFoodSchema } from '../src/nutrition/food.schema.js';
import {
  normalizeHeader,
  parseCsv,
} from '../src/nutrition/food-source-reader.js';
import {
  chooseIfctEnergy,
  deriveIndbServingGrams,
  normalizeSearchTerm,
  parseIfctAliases,
  parseNameAliases,
  transformIfctRow,
  transformIndbRow,
  transformRows,
} from '../src/nutrition/food-transform.js';
import {
  assertServingCurationApproved,
  mergeServingCuration,
  servingCurationSchema,
} from '../src/nutrition/serving-curation.js';
import {
  transformUsdaFood,
  transformUsdaSearchResponse,
} from '../src/nutrition/usda-food-data.js';

const RIGHTS = {
  sourceName: 'Fixture source',
  sourceVersion: 'test-1',
  sourceUrl: 'https://example.com/source',
  licence: 'TEST DATA ONLY',
  approvedForCommercialRedistribution: false,
  approvedBy: null,
  approvedAt: null,
  evidenceUrl: null,
  notes: '',
};

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

function ifctFixture(overrides: Record<string, unknown> = {}) {
  return {
    code: 'A011',
    name: 'Rice flakes',
    scie: 'Oryza sativa',
    lang: 'H. Chiwda; Mar. Poha; Tam. Aval.',
    grup: 'Cereals and Millets',
    tags: 'vegetarian eggetarian fishetarian veg',
    enerc: 1485,
    protcnt: 6.7,
    choavldf: 76.7,
    fatce: 1.2,
    ...overrides,
  };
}

function indbFixture(overrides: Record<string, unknown> = {}) {
  return {
    food_code: 'ASC001',
    food_name: 'Hot tea (Garam Chai)',
    primarysource: 'asc_manual',
    energy_kcal: 20,
    protein_g: 1,
    carb_g: 3,
    fat_g: 0.5,
    servings_unit: 'tea cup',
    unit_serving_energy_kcal: 40,
    unit_serving_protein_g: 2,
    unit_serving_carb_g: 6,
    unit_serving_fat_g: 1,
    ...overrides,
  };
}

function usdaFixture(overrides: Record<string, unknown> = {}) {
  return {
    fdcId: 173180,
    description: 'WHEY PROTEIN',
    dataType: 'SR Legacy',
    foodCategory: 'Beverages',
    publicationDate: '2019-04-01',
    brandOwner: 'ACME NUTRITION',
    servingSize: 30,
    servingSizeUnit: 'g',
    householdServingFullText: '1 scoop',
    foodNutrients: [
      { nutrientId: 1003, nutrientName: 'Protein', unitName: 'G', value: 78.1 },
      { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'G', value: 1.56 },
      { nutrientId: 1005, nutrientName: 'Carbohydrate', unitName: 'G', value: 6.25 },
      { nutrientId: 1008, nutrientName: 'Energy', unitName: 'KCAL', value: 352 },
    ],
    ...overrides,
  };
}

async function main() {
  console.log('\nNutrition data pipeline\n');

  await check('CSV parser preserves commas, quotes, and embedded newlines', () => {
    const rows = parseCsv('Code; code,Food; name\r\nA1,"Rice,\nflakes"\r\n');
    assert.deepEqual(rows, [
      ['Code; code', 'Food; name'],
      ['A1', 'Rice,\nflakes'],
    ]);
    assert.equal(normalizeHeader(rows[0]?.[0]), 'code');
    assert.equal(normalizeHeader(rows[0]?.[1]), 'name');
  });

  await check('IFCT energy converts kJ to kcal', () => {
    const result = chooseIfctEnergy(418.4, {
      proteinG: 10,
      carbsG: 10,
      fatG: 2,
    });
    assert.deepEqual(result, { kcal: 100, energySource: 'source_kj' });
  });

  await check('zero-energy oil is repaired with Atwater factors', () => {
    const result = chooseIfctEnergy(0, {
      proteinG: 0,
      carbsG: 0,
      fatG: 100,
    });
    assert.deepEqual(result, { kcal: 900, energySource: 'atwater_repair' });
  });

  await check('materially contradictory energy is repaired', () => {
    const result = chooseIfctEnergy(418.4, {
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
    });
    assert.deepEqual(result, { kcal: 250, energySource: 'atwater_repair' });
  });

  await check('regional aliases are split and language-labelled', () => {
    const aliases = parseIfctAliases(
      'H. Chiwda; Mar. Poha, Pohe; Tam. Aval.',
    );
    assert.deepEqual(aliases, [
      { lang: 'hindi', name: 'Chiwda' },
      { lang: 'marathi', name: 'Poha' },
      { lang: 'marathi', name: 'Pohe' },
      { lang: 'tamil', name: 'Aval' },
    ]);
  });

  await check('search normalization is case and accent insensitive', () => {
    assert.equal(normalizeSearchTerm('  PÔHĀ / Poha  '), 'poha poha');
  });

  await check('IFCT creates stable IDs, aliases, tags, and a gram serving', () => {
    const food = transformIfctRow(ifctFixture(), RIGHTS);
    assert.equal(food.externalId, 'ifct:A011');
    assert.ok(food.searchTerms.includes('poha'));
    assert.deepEqual(food.dietaryTags, [
      'vegetarian',
      'eggetarian',
      'fishetarian',
    ]);
    assert.deepEqual(food.servings, [
      {
        label: '100 g',
        grams: 100,
        isDefault: true,
        origin: 'fallback_100g',
        evidence: null,
      },
    ]);
    assert.equal(normalizedFoodSchema.safeParse(food).success, true);
  });

  await check('INDB derives serving grams from nutrient ratios', () => {
    assert.equal(deriveIndbServingGrams(indbFixture()), 200);
    const food = transformIndbRow(indbFixture(), RIGHTS);
    assert.equal(food.externalId, 'indb:ASC001');
    assert.equal(food.sourceAttribution, 'asc_manual');
    assert.equal(food.servings[0]?.grams, 200);
    assert.deepEqual(parseNameAliases(food.name), [
      { lang: 'common', name: 'Garam Chai' },
    ]);
    assert.ok(food.searchTerms.includes('garam chai'));
  });

  await check('INDB without a source serving safely falls back to 100 g', () => {
    const food = transformIndbRow(
      indbFixture({
        servings_unit: null,
        unit_serving_energy_kcal: null,
        unit_serving_protein_g: null,
        unit_serving_carb_g: null,
        unit_serving_fat_g: null,
      }),
      RIGHTS,
    );
    assert.deepEqual(food.servings, [
      {
        label: '100 g',
        grams: 100,
        isDefault: true,
        origin: 'fallback_100g',
        evidence: null,
      },
    ]);
  });

  await check('USDA creates a global food with stable ID, macros and serving', () => {
    const food = transformUsdaFood(usdaFixture());
    assert.equal(food.externalId, 'usda:173180');
    assert.equal(food.name, 'Whey Protein (Acme Nutrition)');
    assert.equal(food.source, 'usda');
    assert.equal(food.licence, 'CC0 1.0 Universal');
    assert.deepEqual(food.per100g, {
      kcal: 352,
      proteinG: 78.1,
      carbsG: 6.25,
      fatG: 1.56,
    });
    assert.equal(food.servings[0]?.label, '1 scoop');
    assert.equal(food.servings[0]?.grams, 30);
    assert.equal(food.servings[0]?.isDefault, true);
    assert.equal(food.servings[1]?.label, '100 g');
    assert.equal(normalizedFoodSchema.safeParse(food).success, true);
  });

  await check('USDA handles oats and Greek yogurt without fabricating bad rows', () => {
    const result = transformUsdaSearchResponse({
      foods: [
        usdaFixture({ fdcId: 2020713, description: 'OATS', brandOwner: '' }),
        usdaFixture({
          fdcId: 373595,
          description: 'GREEK YOGURT',
          brandOwner: '',
        }),
        usdaFixture({ fdcId: null }),
      ],
    });
    assert.deepEqual(
      result.foods.map((food) => food.name),
      ['Oats', 'Greek Yogurt'],
    );
    assert.equal(result.errors.length, 1);
  });

  await check('USDA derives energy only when the source omits it', () => {
    const food = transformUsdaFood(
      usdaFixture({
        foodNutrients: [
          { nutrientId: 1003, unitName: 'G', value: 10 },
          { nutrientId: 1004, unitName: 'G', value: 5 },
          { nutrientId: 1005, unitName: 'G', value: 20 },
        ],
      }),
    );
    assert.equal(food.per100g.kcal, 165);
    assert.equal(food.energySource, 'atwater_repair');
  });

  await check('inconsistent INDB serving ratios are rejected', () => {
    assert.throws(
      () => deriveIndbServingGrams(indbFixture({ unit_serving_fat_g: 4 })),
      /ratios disagree/,
    );
  });

  await check('a bad row fails the batch instead of being silently dropped', () => {
    const result = transformRows(
      'ifct2017',
      [ifctFixture(), ifctFixture({ code: '', name: 'Broken' })],
      RIGHTS,
    );
    assert.equal(result.foods.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? '', /row 3/);
  });

  await check('curated serving becomes default while 100 g is retained', () => {
    const food = transformIfctRow(ifctFixture(), RIGHTS);
    const curation = servingCurationSchema.parse({
      schemaVersion: 1,
      reviewedBy: 'Nutrition reviewer',
      reviewedAt: '2026-08-28T12:00:00+05:30',
      reviewNotes: '',
      overrides: [
        {
          externalId: 'ifct:A011',
          mode: 'append',
          servings: [
            {
              label: '1 medium katori',
              grams: 150,
              isDefault: true,
              origin: 'curated',
              evidence: {
                sourceName: 'Fixture measure study',
                sourceUrl: 'https://example.com/servings',
                sourceLocator: 'Table 1, row 2',
                notes: 'Test-only evidence.',
              },
            },
          ],
        },
      ],
    });
    const merged = mergeServingCuration([food], curation)[0];
    assert.equal(merged?.servings.length, 2);
    assert.equal(merged?.servings[0]?.label, '100 g');
    assert.equal(merged?.servings[0]?.isDefault, false);
    assert.equal(merged?.servings[1]?.label, '1 medium katori');
    assert.equal(merged?.servings[1]?.isDefault, true);
  });

  await check('serving curation cannot reference an unknown food', () => {
    const curation = servingCurationSchema.parse({
      schemaVersion: 1,
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: '',
      overrides: [
        {
          externalId: 'ifct:UNKNOWN',
          mode: 'append',
          servings: [
            {
              label: '1 cup',
              grams: 100,
              isDefault: false,
              origin: 'curated',
              evidence: {
                sourceName: 'Fixture',
                sourceUrl: 'https://example.com/servings',
                sourceLocator: 'row 1',
                notes: '',
              },
            },
          ],
        },
      ],
    });
    assert.throws(
      () => mergeServingCuration([transformIfctRow(ifctFixture(), RIGHTS)], curation),
      /unknown food IDs/,
    );
  });

  await check('unreviewed serving overrides cannot enter a release import', () => {
    const curation = servingCurationSchema.parse({
      schemaVersion: 1,
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: '',
      overrides: [],
    });
    assert.throws(
      () => assertServingCurationApproved(curation),
      /not approved/,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

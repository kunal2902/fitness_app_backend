/** Builds the local, review-only data used by the serving curation workbook. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  rightsManifestSchema,
  type NormalizedFood,
  type RightsManifest,
} from '../src/nutrition/food.schema.js';
import {
  readCsvRows,
  readXlsxRows,
} from '../src/nutrition/food-source-reader.js';
import { transformRows } from '../src/nutrition/food-transform.js';

interface Options {
  ifctPath: string;
  indbPath: string;
  rightsPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'Usage: npm run review:servings -- --ifct file.csv --indb file.xlsx ' +
          '--rights manifest.json --out review.json',
      );
    }
    values.set(key, value);
  }

  const required = ['--ifct', '--indb', '--rights', '--out'] as const;
  for (const key of required) {
    if (!values.get(key)) throw new Error(`Missing required argument ${key}`);
  }
  return {
    ifctPath: values.get('--ifct') as string,
    indbPath: values.get('--indb') as string,
    rightsPath: values.get('--rights') as string,
    outPath: values.get('--out') as string,
  };
}

async function readManifest(filePath: string): Promise<RightsManifest> {
  const raw = await readFile(path.resolve(filePath), 'utf8');
  return rightsManifestSchema.parse(JSON.parse(raw));
}

function reviewRow(food: NormalizedFood) {
  const defaultServing = food.servings.find((serving) => serving.isDefault);
  const householdServings = food.servings.filter(
    (serving) => serving.origin !== 'fallback_100g',
  );
  return {
    externalId: food.externalId,
    name: food.name,
    source: food.source,
    group: food.group,
    isRecipe: food.isRecipe,
    currentDefault: defaultServing?.label ?? '',
    currentDefaultGrams: defaultServing?.grams ?? null,
    householdServings: householdServings
      .map((serving) => `${serving.label} (${serving.grams} g)`)
      .join('; '),
    servingStatus: householdServings.length > 0 ? 'Ready' : 'Needs curation',
    kcalPer100g: food.per100g.kcal,
    proteinPer100g: food.per100g.proteinG,
    carbsPer100g: food.per100g.carbsG,
    fatPer100g: food.per100g.fatG,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(options.rightsPath);
  const [ifctRows, indbRows] = await Promise.all([
    readCsvRows(path.resolve(options.ifctPath)),
    readXlsxRows(path.resolve(options.indbPath)),
  ]);
  const ifct = transformRows('ifct2017', ifctRows, manifest.sources.ifct2017);
  const indb = transformRows('indb', indbRows, manifest.sources.indb);
  const errors = [...ifct.errors, ...indb.errors];
  if (errors.length > 0) {
    throw new Error(
      `Review export rejected ${errors.length} invalid row(s):\n` +
        errors.slice(0, 20).join('\n'),
    );
  }

  const foods = [...ifct.foods, ...indb.foods].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  );
  const rows = foods.map(reviewRow);
  const output = path.resolve(options.outPath);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      recordCount: rows.length,
      sourceServingCount: rows.filter((row) => row.servingStatus === 'Ready')
        .length,
      rows,
    })}\n`,
    'utf8',
  );
  await rename(temporary, output);
  console.log(`Serving review data: ${output}`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});

/**
 * Validates and imports the approved nutrition catalogues.
 *
 * Dry run (no file/database writes):
 *   npm run seed:foods -- --ifct path/to/index.csv --indb path/to/INDB.xlsx \
 *     --rights data/nutrition/rights-manifest.local.json --dry-run
 *
 * Local development import (upserts MongoDB only, writes no shippable asset):
 *   npm run seed:foods -- --ifct path/to/index.csv --indb path/to/INDB.xlsx \
 *     --local-only
 *
 * Approved release import (writes JSON bundle and upserts MongoDB):
 *   npm run seed:foods -- --ifct path/to/index.csv --indb path/to/INDB.xlsx \
 *     --rights data/nutrition/rights-manifest.local.json
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

import {
  rightsManifestSchema,
  type IngestionFoodSource,
  type NormalizedFood,
  type RightsManifest,
} from '../src/nutrition/food.schema.js';
import {
  readCsvRows,
  readXlsxRows,
} from '../src/nutrition/food-source-reader.js';
import { transformRows } from '../src/nutrition/food-transform.js';
import {
  assertServingCurationApproved,
  loadServingCuration,
  mergeServingCuration,
  type ServingCuration,
} from '../src/nutrition/serving-curation.js';
import { connectToDB, disconnectFromDB } from '../src/utils/dbConnect.js';

interface CliOptions {
  ifctPath?: string;
  indbPath?: string;
  rightsPath: string;
  servingsPath?: string;
  outPath: string;
  dryRun: boolean;
  /**
   * Populate the local database without producing the shippable asset.
   *
   * The rights gate exists to stop unapproved data being *redistributed* —
   * bundled into a build and handed to users. Loading a dataset you have
   * already downloaded into your own development database is use, not
   * redistribution, and blocking it only means the feature cannot be run
   * at all before a licence review completes. This mode draws that line
   * precisely: MongoDB is written, `nutrition_foods.v1.json` is not.
   */
  localOnly: boolean;
}

const DEFAULT_RIGHTS_PATH = 'data/nutrition/rights-manifest.local.json';
const DEFAULT_OUT_PATH = 'data/nutrition/generated/nutrition_foods.v1.json';

function usage(): string {
  return [
    'Usage: npm run seed:foods -- [--ifct file.csv] [--indb file.xlsx]',
    '       [--rights manifest.json] [--servings curation.json]',
    '       [--out catalogue.json] [--dry-run] [--local-only]',
    '',
    'At least one source is required.',
    '',
    '  --dry-run     Validate only. Writes nothing.',
    '  --local-only  Upsert MongoDB for development. Does NOT write the',
    '                shippable catalogue asset and claims no redistribution',
    '                rights, so no manifest approval is required.',
    '',
    'A full release import (neither flag) writes the shippable asset and',
    'requires every supplied source to be approved for commercial',
    'redistribution in the rights manifest.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    rightsPath: DEFAULT_RIGHTS_PATH,
    outPath: DEFAULT_OUT_PATH,
    dryRun: false,
    localOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--local-only') {
      options.localOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg ?? 'argument'}\n\n${usage()}`);
    }
    if (arg === '--ifct') options.ifctPath = value;
    else if (arg === '--indb') options.indbPath = value;
    else if (arg === '--rights') options.rightsPath = value;
    else if (arg === '--servings') options.servingsPath = value;
    else if (arg === '--out') options.outPath = value;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    index += 1;
  }

  if (!options.ifctPath && !options.indbPath) {
    throw new Error(`Supply --ifct, --indb, or both.\n\n${usage()}`);
  }
  return options;
}

async function loadManifest(filePath: string): Promise<RightsManifest> {
  let raw: string;
  try {
    raw = await readFile(path.resolve(filePath), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Rights manifest not found at ${filePath}. Copy ` +
          'data/nutrition/rights-manifest.example.json to the local manifest ' +
          'and have the approvals completed before a release import.',
      );
    }
    throw error;
  }
  return rightsManifestSchema.parse(JSON.parse(raw));
}

function assertApproved(
  source: IngestionFoodSource,
  manifest: RightsManifest,
): void {
  const rights = manifest.sources[source];
  if (
    !rights.approvedForCommercialRedistribution ||
    !rights.approvedBy ||
    !rights.approvedAt ||
    !rights.evidenceUrl
  ) {
    throw new Error(
      `${source} is not approved for commercial redistribution. ` +
        'A non-dry import is blocked until approval, date, reviewer, and ' +
        'evidence URL are recorded in the rights manifest.',
    );
  }
}

async function transformSources(
  options: CliOptions,
  manifest: RightsManifest,
): Promise<NormalizedFood[]> {
  const foods: NormalizedFood[] = [];
  const errors: string[] = [];

  if (options.ifctPath) {
    const rows = await readCsvRows(path.resolve(options.ifctPath));
    const result = transformRows('ifct2017', rows, manifest.sources.ifct2017);
    foods.push(...result.foods);
    errors.push(...result.errors);
    console.log(`  IFCT: ${result.foods.length}/${rows.length} valid records`);
  }

  if (options.indbPath) {
    const rows = await readXlsxRows(path.resolve(options.indbPath));
    const result = transformRows('indb', rows, manifest.sources.indb);
    foods.push(...result.foods);
    errors.push(...result.errors);
    console.log(`  INDB: ${result.foods.length}/${rows.length} valid records`);
  }

  const ids = new Set<string>();
  for (const food of foods) {
    if (ids.has(food.externalId)) {
      errors.push(`Combined catalogue has duplicate ${food.externalId}`);
    }
    ids.add(food.externalId);
  }

  if (errors.length > 0) {
    const preview = errors.slice(0, 20).map((error) => `  - ${error}`).join('\n');
    const remaining = errors.length > 20 ? `\n  ...and ${errors.length - 20} more` : '';
    throw new Error(
      `Import rejected: ${errors.length} invalid record(s).\n${preview}${remaining}`,
    );
  }

  // Recipes are the primary user-facing corpus; deterministic ordering makes
  // the generated bundle reviewable and stable across repeated runs.
  return foods.sort((left, right) => {
    if (left.isRecipe !== right.isRecipe) return left.isRecipe ? -1 : 1;
    return left.name.localeCompare(right.name, 'en');
  });
}

async function writeCatalogue(
  outPath: string,
  foods: ReadonlyArray<NormalizedFood>,
): Promise<void> {
  const resolved = path.resolve(outPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const sourceCounts = foods.reduce<Record<string, number>>((counts, food) => {
    counts[food.source] = (counts[food.source] ?? 0) + 1;
    return counts;
  }, {});
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    recordCount: foods.length,
    sourceCounts,
    foods,
  };
  const temporary = `${resolved}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(temporary, resolved);
  console.log(`  Bundle: ${resolved}`);
}

async function upsertFoods(foods: ReadonlyArray<NormalizedFood>): Promise<void> {
  await connectToDB();
  const collection = mongoose.connection.collection('foods');
  await collection.createIndex({ externalId: 1 }, { unique: true });
  await collection.createIndex(
    { name: 'text', searchTerms: 'text' },
    {
      weights: { name: 10, searchTerms: 5 },
      name: 'food_search_text',
    },
  );

  const now = new Date();
  const result = await collection.bulkWrite(
    foods.map((food) => ({
      updateOne: {
        filter: { externalId: food.externalId },
        update: {
          $set: { ...food, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  console.log(
    `  MongoDB: ${result.upsertedCount} inserted, ` +
      `${result.modifiedCount} updated, ${result.matchedCount} matched`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(options.rightsPath);
  console.log('\nValidating nutrition sources\n');
  let foods = await transformSources(options, manifest);
  let servingCuration: ServingCuration | null = null;
  if (options.servingsPath) {
    servingCuration = await loadServingCuration(
      path.resolve(options.servingsPath),
    );
    foods = mergeServingCuration(foods, servingCuration);
    console.log(
      `  Serving overrides: ${servingCuration.overrides.length} food(s)`,
    );
  }

  const repaired = foods.filter(
    (food) => food.energySource === 'atwater_repair',
  ).length;
  const withHouseholdServing = foods.filter((food) =>
    food.servings.some((serving) => serving.origin !== 'fallback_100g'),
  ).length;
  console.log(`  Total: ${foods.length} valid records (${repaired} energy repairs)`);
  console.log(
    `  Serving coverage: ${withHouseholdServing}/${foods.length} foods have ` +
      'a source or curated household serving',
  );

  if (options.dryRun) {
    console.log('\nDry run complete. No files or database records were written.\n');
    return;
  }

  if (options.localOnly) {
    // No approval check and no asset written: nothing leaves this machine.
    console.log(
      '\nLocal development import. No redistribution rights are claimed ' +
        'and\nthe shippable catalogue asset was NOT written. Run without ' +
        '--local-only\nonce the rights manifest records an approval.\n',
    );
    try {
      await upsertFoods(foods);
    } finally {
      await disconnectFromDB();
    }
    console.log('\nLocal food catalogue loaded into MongoDB.\n');
    return;
  }

  if (options.ifctPath) assertApproved('ifct2017', manifest);
  if (options.indbPath) assertApproved('indb', manifest);
  if (servingCuration) assertServingCurationApproved(servingCuration);

  // Write the app asset only after all data validates and all rights gates pass.
  await writeCatalogue(options.outPath, foods);
  try {
    await upsertFoods(foods);
  } finally {
    await disconnectFromDB();
  }
  console.log('\nNutrition catalogue import complete.\n');
}

main().catch(async (error: unknown) => {
  console.error(`\n${(error as Error).message}\n`);
  if (mongoose.connection.readyState !== 0) await disconnectFromDB();
  process.exit(1);
});

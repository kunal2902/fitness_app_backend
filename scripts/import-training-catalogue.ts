import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertPublishable, catalogueReport, validateTrainingCatalogue } from '../src/training/catalogue-policy.js';

const usage = `Usage: npm run seed:training -- [--file catalogue.json] [--dry-run] [--publish]

Default input: data/training/starter-catalogue.json
Default action: validate and STAGE an immutable release in MongoDB.
--dry-run  Validate/report only. No environment, network, database or file writes.
--publish  Require all content/source/media approvals, then activate a complete release.
           With --dry-run, check publication eligibility without writing.
--help     Show this help.

Changed content needs a new releaseId/catalogueVersion. Changed exercise/workout
semantics also need a new record version. No command bypasses publication gates.`;

function parseArgs(argv: string[]) {
  let file = 'data/training/starter-catalogue.json';
  let dryRun = false;
  let publish = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--publish') publish = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--file') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--file needs a JSON file path');
      file = value;
    } else throw new Error(`Unknown argument ${argument}. Use --help.`);
  }
  return { file: path.resolve(file), dryRun, publish, help };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if ((await stat(options.file)).size > 8 * 1024 * 1024) throw new Error('Catalogue exceeds the 8 MiB import limit');
  const catalogue = validateTrainingCatalogue(JSON.parse(await readFile(options.file, 'utf8')));
  const report = catalogueReport(catalogue);
  console.log(JSON.stringify(report, null, 2));
  if (options.publish) assertPublishable(catalogue);
  if (options.dryRun) { console.log('Dry run complete. Nothing written.'); return; }

  // Keep help/dry-run independent of environment/secrets and MongoDB.
  const [{ connectToDB, disconnectFromDB }, { MongoCatalogueImportStore, importTrainingCatalogue }] = await Promise.all([
    import('../src/utils/dbConnect.js'), import('../src/training/catalogue-import.js'),
  ]);
  try {
    await connectToDB();
    const store = new MongoCatalogueImportStore();
    await store.initialize();
    const result = await importTrainingCatalogue(catalogue, store, { publish: options.publish });
    const action = result.activated ? 'Published and activated' : result.published ? 'Existing published release retained (active selection unchanged)' : 'Staged (not user-visible)';
    console.log(`${action} ${result.releaseId}.`);
    if (!result.published) console.log('Next: complete actual editorial/rights review before attempting --publish.');
  } finally {
    await disconnectFromDB();
  }
}

main().catch((error: unknown) => {
  const detail = error as NodeJS.ErrnoException;
  console.error(detail.code === 'ENOENT'
    ? 'Catalogue file not found. Use --file path/to/catalogue.json or the bundled starter.'
    : error instanceof Error ? error.message : 'Training catalogue import failed');
  process.exitCode = 1;
});

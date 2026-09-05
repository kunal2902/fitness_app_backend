/** Converts approved rows in the serving workbook to importer-ready JSON. */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readSheet } from 'read-excel-file/node';

import { servingCurationSchema } from '../src/nutrition/serving-curation.js';

interface Options {
  workbookPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'Usage: npm run export:servings -- --workbook curation.xlsx ' +
          '--out serving-curation.local.json',
      );
    }
    values.set(key, value);
  }
  const workbookPath = values.get('--workbook');
  const outPath = values.get('--out');
  if (!workbookPath || !outPath) {
    throw new Error('Both --workbook and --out are required');
  }
  return { workbookPath, outPath };
}

function cellText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '').trim();
}

function normalizedHeader(value: unknown): string {
  return cellText(value)
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isYes(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ['yes', 'true', '1', 'include'].includes(
    cellText(value).toLocaleLowerCase('en'),
  );
}

function findHeaderRow(matrix: unknown[][]): number {
  const index = matrix.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return headers.includes('include') && headers.includes('external_id');
  });
  if (index < 0) {
    throw new Error('Serving Overrides sheet has no recognizable header row');
  }
  return index;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workbook = path.resolve(options.workbookPath);
  const [overrideMatrix, metadataMatrix] = await Promise.all([
    readSheet(workbook, 'Serving Overrides'),
    readSheet(workbook, 'Review Metadata'),
  ]);
  const headerIndex = findHeaderRow(overrideMatrix as unknown[][]);
  const headers = (overrideMatrix[headerIndex] ?? []).map(normalizedHeader);
  const groups = new Map<
    string,
    { externalId: string; mode: 'append' | 'replace'; servings: unknown[] }
  >();

  (overrideMatrix as unknown[][])
    .slice(headerIndex + 1)
    .forEach((row, offset) => {
      const value = (key: string) => row[headers.indexOf(key)];
      if (!isYes(value('include'))) return;
      const externalId = cellText(value('external_id'));
      const modeText = cellText(value('mode')).toLocaleLowerCase('en');
      const mode = modeText === 'replace' ? 'replace' : 'append';
      const grams = Number(value('grams'));
      if (!externalId || !Number.isFinite(grams)) {
        throw new Error(
          `Serving Overrides row ${headerIndex + offset + 2} requires ` +
            'external_id and numeric grams',
        );
      }
      const existing = groups.get(externalId);
      if (existing && existing.mode !== mode) {
        throw new Error(`${externalId} uses more than one override mode`);
      }
      const group = existing ?? { externalId, mode, servings: [] };
      group.servings.push({
        label: cellText(value('label')),
        grams,
        isDefault: isYes(value('is_default')),
        origin: 'curated',
        evidence: {
          sourceName: cellText(value('evidence_source')),
          sourceUrl: cellText(value('evidence_url')),
          sourceLocator: cellText(value('evidence_locator')),
          notes: cellText(value('notes')),
        },
      });
      groups.set(externalId, group);
    });

  const metadata = new Map(
    (metadataMatrix as unknown[][])
      .filter((row) => cellText(row[0]))
      .map((row) => [normalizedHeader(row[0]), cellText(row[1])]),
  );
  const curation = servingCurationSchema.parse({
    schemaVersion: 1,
    reviewedBy: metadata.get('reviewed_by') || null,
    reviewedAt: metadata.get('reviewed_at') || null,
    reviewNotes: metadata.get('review_notes') ?? '',
    overrides: [...groups.values()],
  });

  const output = path.resolve(options.outPath);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, `${JSON.stringify(curation, null, 2)}\n`, 'utf8');
  await rename(temporary, output);
  console.log(`Serving curation JSON: ${output}`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});

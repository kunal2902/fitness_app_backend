import { readFile } from 'node:fs/promises';

import { readSheet, type CellValue } from 'read-excel-file/node';

export type SourceRow = Record<string, unknown>;

/**
 * IFCT package releases have used both compact keys (`enerc`) and labelled
 * headers (`Energy; enerc`). Keep the stable key after the final semicolon.
 */
export function normalizeHeader(value: unknown): string {
  const raw = String(value ?? '').replace(/^\uFEFF/, '').trim();
  const key = raw.includes(';') ? raw.split(';').at(-1) ?? raw : raw;
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** RFC-4180-style parser, including escaped quotes and quoted newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV ended inside a quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function matrixToRows(matrix: ReadonlyArray<ReadonlyArray<unknown>>): SourceRow[] {
  const headerRow = matrix[0];
  if (!headerRow) throw new Error('Source file is empty');

  const headers = headerRow.map(normalizeHeader);
  if (headers.some((header) => header.length === 0)) {
    throw new Error('Source file contains an empty column header');
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error('Source file contains duplicate normalized column headers');
  }

  return matrix.slice(1).flatMap((values) => {
    if (values.every((value) => value === null || String(value).trim() === '')) {
      return [];
    }
    const row: SourceRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? null;
    });
    return [row];
  });
}

export async function readCsvRows(path: string): Promise<SourceRow[]> {
  const input = await readFile(path, 'utf8');
  return matrixToRows(parseCsv(input));
}

export async function readXlsxRows(path: string): Promise<SourceRow[]> {
  const matrix = await readSheet(path);
  return matrixToRows(matrix as CellValue[][]);
}


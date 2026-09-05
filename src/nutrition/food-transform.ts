import {
  normalizedFoodSchema,
  type EnergySource,
  type FoodAlias,
  type FoodMacros,
  type FoodServing,
  type NormalizedFood,
  type RightsEntry,
} from './food.schema.js';
import type { SourceRow } from './food-source-reader.js';

const KJ_PER_KCAL = 4.184;
const ENERGY_MISMATCH_THRESHOLD = 0.15;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  A: 'assamese',
  B: 'bengali',
  G: 'gujarati',
  H: 'hindi',
  Kan: 'kannada',
  Kash: 'kashmiri',
  Kh: 'khasi',
  Kon: 'konkani',
  Mal: 'malayalam',
  M: 'manipuri',
  Mar: 'marathi',
  O: 'odia',
  P: 'punjabi',
  S: 'sanskrit',
  Tam: 'tamil',
  Tel: 'telugu',
  U: 'urdu',
};

const DIETARY_TAGS = new Set(['vegetarian', 'eggetarian', 'fishetarian']);

function text(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function requiredText(row: SourceRow, key: string): string {
  const value = text(row[key]);
  if (!value) throw new Error(`Missing required value: ${key}`);
  return value;
}

function requiredNumber(row: SourceRow, key: string): number {
  const value = row[key];
  if (value === null || value === undefined || text(value) === '') {
    throw new Error(`Missing required numeric value: ${key}`);
  }
  const parsed = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${key}: ${text(value)}`);
  }
  return parsed;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function normalizeSearchTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseIfctAliases(value: unknown): FoodAlias[] {
  const aliases: FoodAlias[] = [];
  const seen = new Set<string>();

  for (const segment of text(value).split(';')) {
    const match = segment.trim().match(/^([A-Za-z]+)\.\s*(.+?)\.?$/);
    if (!match) continue;
    const prefix = match[1];
    const names = text(match[2]).split(',');
    if (!prefix) continue;

    for (const candidate of names) {
      const name = text(candidate).replace(/\.$/, '');
      const key = normalizeSearchTerm(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      aliases.push({
        lang: LANGUAGE_NAMES[prefix] ?? prefix.toLowerCase(),
        name,
      });
    }
  }
  return aliases;
}

export function parseNameAliases(name: string): FoodAlias[] {
  const aliases: FoodAlias[] = [];
  const seen = new Set<string>();
  const pattern = /\(([^()]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(name)) !== null) {
    const inner = text(match[1]);
    if (!inner || /^with\b/i.test(inner)) continue;
    for (const candidate of inner.split(/[;/|]/)) {
      const alias = text(candidate);
      const key = normalizeSearchTerm(alias);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      aliases.push({ lang: 'common', name: alias });
    }
  }
  return aliases;
}

function uniqueSearchTerms(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map(normalizeSearchTerm).filter(Boolean))];
}

export function chooseIfctEnergy(
  energyKj: number,
  macros: Pick<FoodMacros, 'proteinG' | 'carbsG' | 'fatG'>,
): { kcal: number; energySource: EnergySource } {
  const sourceKcal = energyKj / KJ_PER_KCAL;
  const atwater = macros.proteinG * 4 + macros.carbsG * 4 + macros.fatG * 9;
  const differsMaterially =
    sourceKcal > 0 &&
    atwater > 0 &&
    Math.abs(sourceKcal - atwater) / sourceKcal > ENERGY_MISMATCH_THRESHOLD;

  if (sourceKcal <= 0 || differsMaterially) {
    return { kcal: round(atwater), energySource: 'atwater_repair' };
  }
  return { kcal: round(sourceKcal), energySource: 'source_kj' };
}

function buildSearchTerms(
  name: string,
  scientificName: string | null,
  aliases: ReadonlyArray<FoodAlias>,
): string[] {
  return uniqueSearchTerms([
    name,
    scientificName ?? '',
    ...aliases.map((alias) => alias.name),
  ]);
}

function normalizeTags(value: unknown): string[] {
  return [
    ...new Set(
      text(value)
        .toLowerCase()
        .split(/\s+/)
        .filter((tag) => DIETARY_TAGS.has(tag)),
    ),
  ];
}

function sourceFields(rights: RightsEntry) {
  return {
    sourceName: rights.sourceName,
    sourceVersion: rights.sourceVersion,
    sourceUrl: rights.sourceUrl,
    licence: rights.licence,
  };
}

export function transformIfctRow(
  row: SourceRow,
  rights: RightsEntry,
): NormalizedFood {
  const code = requiredText(row, 'code').toUpperCase();
  const name = requiredText(row, 'name');
  const scientificName = text(row.scie) || null;
  const aliases = parseIfctAliases(row.lang);
  const proteinG = requiredNumber(row, 'protcnt');
  const carbsG = requiredNumber(row, 'choavldf');
  const fatG = requiredNumber(row, 'fatce');
  const energy = chooseIfctEnergy(requiredNumber(row, 'enerc'), {
    proteinG,
    carbsG,
    fatG,
  });

  return normalizedFoodSchema.parse({
    externalId: `ifct:${code}`,
    name,
    scientificName,
    aliases,
    searchTerms: buildSearchTerms(name, scientificName, aliases),
    group: requiredText(row, 'grup'),
    dietaryTags: normalizeTags(row.tags),
    per100g: {
      kcal: energy.kcal,
      proteinG: round(proteinG),
      carbsG: round(carbsG),
      fatG: round(fatG),
    },
    servings: [
      {
        label: '100 g',
        grams: 100,
        isDefault: true,
        origin: 'fallback_100g',
        evidence: null,
      },
    ],
    source: 'ifct2017',
    ...sourceFields(rights),
    sourceAttribution: null,
    energySource: energy.energySource,
    verified: true,
    isRecipe: false,
  });
}

/**
 * INDB provides per-100 g and per-serving nutrients, but not serving grams.
 * The serving weight is the median ratio across kcal and the three macros.
 * Median makes the conversion robust to a single rounded zero/small value.
 */
export function deriveIndbServingGrams(row: SourceRow): number | null {
  const pairs = [
    ['energy_kcal', 'unit_serving_energy_kcal'],
    ['protein_g', 'unit_serving_protein_g'],
    ['carb_g', 'unit_serving_carb_g'],
    ['fat_g', 'unit_serving_fat_g'],
  ] as const;

  const ratios = pairs.flatMap(([per100Key, servingKey]) => {
    const per100 = Number(row[per100Key]);
    const serving = Number(row[servingKey]);
    if (!Number.isFinite(per100) || !Number.isFinite(serving) || per100 <= 0) {
      return [];
    }
    const grams = (serving / per100) * 100;
    return Number.isFinite(grams) && grams > 0 ? [grams] : [];
  });

  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  if (median === undefined) return null;

  const maxRelativeDifference = Math.max(
    ...ratios.map((value) => Math.abs(value - median) / median),
  );
  if (maxRelativeDifference > 0.03) {
    throw new Error(
      `INDB serving nutrient ratios disagree by ${round(
        maxRelativeDifference * 100,
        2,
      )}%`,
    );
  }
  return round(median, 2);
}

export function transformIndbRow(
  row: SourceRow,
  rights: RightsEntry,
): NormalizedFood {
  const code = requiredText(row, 'food_code').toUpperCase();
  const name = requiredText(row, 'food_name');
  const aliases = parseNameAliases(name);
  const servingLabel = text(row.servings_unit);
  const servingGrams = servingLabel ? deriveIndbServingGrams(row) : null;
  const servings: FoodServing[] = servingGrams
    ? [
        {
          label: servingLabel,
          grams: servingGrams,
          isDefault: true,
          origin: 'source_dataset',
          evidence: {
            sourceName: rights.sourceName,
            sourceUrl: rights.sourceUrl,
            sourceLocator: `${code} servings_unit`,
            notes: 'Serving grams derived from matching per-serving and per-100 g nutrient ratios.',
          },
        },
        {
          label: '100 g',
          grams: 100,
          isDefault: false,
          origin: 'fallback_100g',
          evidence: null,
        },
      ]
    : [
        {
          label: '100 g',
          grams: 100,
          isDefault: true,
          origin: 'fallback_100g',
          evidence: null,
        },
      ];

  return normalizedFoodSchema.parse({
    externalId: `indb:${code}`,
    name,
    scientificName: null,
    aliases,
    searchTerms: buildSearchTerms(name, null, aliases),
    group: 'Indian Recipes',
    dietaryTags: [],
    per100g: {
      kcal: round(requiredNumber(row, 'energy_kcal')),
      proteinG: round(requiredNumber(row, 'protein_g')),
      carbsG: round(requiredNumber(row, 'carb_g')),
      fatG: round(requiredNumber(row, 'fat_g')),
    },
    servings,
    source: 'indb',
    ...sourceFields(rights),
    sourceAttribution: text(row.primarysource) || null,
    energySource: 'source_kcal',
    verified: true,
    isRecipe: true,
  });
}

export interface TransformResult {
  foods: NormalizedFood[];
  errors: string[];
}

export function transformRows(
  source: 'ifct2017' | 'indb',
  rows: ReadonlyArray<SourceRow>,
  rights: RightsEntry,
): TransformResult {
  const foods: NormalizedFood[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();

  rows.forEach((row, index) => {
    try {
      const food =
        source === 'ifct2017'
          ? transformIfctRow(row, rights)
          : transformIndbRow(row, rights);
      if (ids.has(food.externalId)) {
        throw new Error(`Duplicate externalId ${food.externalId}`);
      }
      ids.add(food.externalId);
      foods.push(food);
    } catch (error) {
      errors.push(
        `${source} row ${index + 2}: ${(error as Error).message}`,
      );
    }
  });

  return { foods, errors };
}

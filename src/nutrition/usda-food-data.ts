import {
  normalizedFoodSchema,
  type FoodMacros,
  type FoodServing,
  type NormalizedFood,
} from './food.schema.js';
import { normalizeSearchTerm } from './food-transform.js';

const SOURCE_NAME = 'USDA FoodData Central';
const SOURCE_HOME = 'https://fdc.nal.usda.gov/';
const SOURCE_ATTRIBUTION =
  'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central.';
const SOURCE_LICENCE = 'CC0 1.0 Universal';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clipped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function displayCase(value: string): string {
  if (!/[A-Z]/.test(value) || value !== value.toLocaleUpperCase('en')) {
    return value;
  }
  return value
    .toLocaleLowerCase('en')
    .replace(/(^|[\s,/(\-])([a-z])/g, (_match, before: string, letter: string) =>
      `${before}${letter.toLocaleUpperCase('en')}`,
    );
}

function nutrientRows(food: UnknownRecord): UnknownRecord[] {
  return Array.isArray(food.foodNutrients)
    ? food.foodNutrients.flatMap((value) => {
        const row = record(value);
        return row ? [row] : [];
      })
    : [];
}

function nutrientValue(
  food: UnknownRecord,
  ids: ReadonlySet<number>,
  legacyNumbers: ReadonlySet<string>,
): { value: number; unit: string } | null {
  for (const row of nutrientRows(food)) {
    const nested = record(row.nutrient);
    const id = finiteNumber(row.nutrientId ?? nested?.id);
    const number = text(row.nutrientNumber ?? nested?.number);
    if (!(id !== null && ids.has(id)) && !legacyNumbers.has(number)) continue;
    const value = finiteNumber(row.value ?? row.amount);
    if (value === null || value < 0) continue;
    return {
      value,
      unit: text(row.unitName ?? nested?.unitName).toLocaleUpperCase('en'),
    };
  }
  return null;
}

function requiredMacro(
  food: UnknownRecord,
  ids: ReadonlySet<number>,
  legacyNumbers: ReadonlySet<string>,
  name: string,
): number {
  const nutrient = nutrientValue(food, ids, legacyNumbers);
  if (!nutrient) throw new Error(`Missing ${name}`);
  if (nutrient.unit && nutrient.unit !== 'G') {
    throw new Error(`${name} uses unsupported unit ${nutrient.unit}`);
  }
  return round(nutrient.value);
}

function macros(food: UnknownRecord): {
  per100g: FoodMacros;
  energySource: 'source_kcal' | 'source_kj' | 'atwater_repair';
} {
  const proteinG = requiredMacro(food, new Set([1003]), new Set(['203']), 'protein');
  const fatG = requiredMacro(food, new Set([1004]), new Set(['204']), 'fat');
  const carbsG = requiredMacro(
    food,
    new Set([1005]),
    new Set(['205']),
    'carbohydrate',
  );
  const kcal = nutrientValue(
    food,
    new Set([1008, 2047, 2048]),
    new Set(['208']),
  );
  const kj = nutrientValue(food, new Set([1062]), new Set(['268']));

  if (kcal && (!kcal.unit || kcal.unit === 'KCAL')) {
    return {
      per100g: { kcal: round(kcal.value), proteinG, carbsG, fatG },
      energySource: 'source_kcal',
    };
  }
  if (kj && (!kj.unit || kj.unit === 'KJ')) {
    return {
      per100g: {
        kcal: round(kj.value / 4.184),
        proteinG,
        carbsG,
        fatG,
      },
      energySource: 'source_kj',
    };
  }
  return {
    per100g: {
      kcal: round(proteinG * 4 + carbsG * 4 + fatG * 9),
      proteinG,
      carbsG,
      fatG,
    },
    energySource: 'atwater_repair',
  };
}

function sourceServing(food: UnknownRecord, fdcId: number): FoodServing | null {
  const grams = finiteNumber(food.servingSize);
  const unit = normalizeSearchTerm(text(food.servingSizeUnit));
  if (
    grams === null ||
    grams <= 0 ||
    grams > 10_000 ||
    !['g', 'gram', 'grams', 'grm'].includes(unit)
  ) {
    return null;
  }

  const suppliedLabel = text(food.householdServingFullText);
  const label = clipped(suppliedLabel || `${round(grams, 2)} g`, 80);
  if (normalizeSearchTerm(label).replace(/\s+/g, '') === '100g') return null;

  return {
    label,
    grams: round(grams, 2),
    isDefault: true,
    origin: 'source_dataset',
    evidence: {
      sourceName: SOURCE_NAME,
      sourceUrl: `${SOURCE_HOME}fdc-app.html#/food-details/${fdcId}/nutrients`,
      sourceLocator: `FDC ${fdcId} servingSize`,
      notes: 'Gram serving supplied by FoodData Central.',
    },
  };
}

function searchTerms(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map(normalizeSearchTerm).filter(Boolean))];
}

/** Converts one abridged FoodData Central search row to the app contract. */
export function transformUsdaFood(value: unknown): NormalizedFood {
  const food = record(value);
  if (!food) throw new Error('FoodData Central row is not an object');
  const fdcId = finiteNumber(food.fdcId);
  if (fdcId === null || !Number.isInteger(fdcId) || fdcId <= 0) {
    throw new Error('Missing valid fdcId');
  }
  const rawDescription = text(food.description);
  if (!rawDescription) throw new Error('Missing description');
  const description = displayCase(rawDescription);
  const brand = displayCase(text(food.brandName) || text(food.brandOwner));
  const descriptionKey = normalizeSearchTerm(description);
  const brandKey = normalizeSearchTerm(brand);
  const name = clipped(
    brand && !descriptionKey.includes(brandKey)
      ? `${description} (${brand})`
      : description,
    200,
  );
  const dataType = text(food.dataType) || 'FoodData Central';
  const category = displayCase(text(food.foodCategory)) || dataType;
  const nutrition = macros(food);
  const preferredServing = sourceServing(food, fdcId);
  const servings: FoodServing[] = [
    ...(preferredServing ? [preferredServing] : []),
    {
      label: '100 g',
      grams: 100,
      isDefault: preferredServing === null,
      origin: 'fallback_100g',
      evidence: null,
    },
  ];
  const commonNames = Array.isArray(food.commonNames)
    ? food.commonNames.map(text)
    : [text(food.commonNames)];
  const additionalDescriptions = Array.isArray(food.additionalDescriptions)
    ? food.additionalDescriptions.map(text)
    : [text(food.additionalDescriptions)];

  return normalizedFoodSchema.parse({
    externalId: `usda:${fdcId}`,
    name,
    scientificName: text(food.scientificName) || null,
    aliases:
      name === description ? [] : [{ lang: 'common', name: description }],
    searchTerms: searchTerms([
      name,
      description,
      brand,
      ...commonNames,
      ...additionalDescriptions,
    ]),
    group: clipped(category, 120),
    dietaryTags: [],
    per100g: nutrition.per100g,
    servings,
    source: 'usda',
    sourceName: SOURCE_NAME,
    sourceVersion: clipped(text(food.publicationDate) || 'live', 80),
    sourceUrl: `${SOURCE_HOME}fdc-app.html#/food-details/${fdcId}/nutrients`,
    sourceAttribution: clipped(brand || SOURCE_ATTRIBUTION, 200),
    licence: SOURCE_LICENCE,
    energySource: nutrition.energySource,
    verified: true,
    isRecipe: dataType.toLocaleLowerCase('en').includes('survey'),
  });
}

export function transformUsdaSearchResponse(value: unknown): {
  foods: NormalizedFood[];
  errors: string[];
} {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.foods)) {
    throw new Error('FoodData Central response is missing foods');
  }
  const foods: NormalizedFood[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  payload.foods.forEach((row, index) => {
    try {
      const food = transformUsdaFood(row);
      if (ids.has(food.externalId)) return;
      ids.add(food.externalId);
      foods.push(food);
    } catch (error) {
      errors.push(`USDA result ${index + 1}: ${(error as Error).message}`);
    }
  });
  return { foods, errors };
}

import { z } from 'zod';

export const FOOD_SOURCES = [
  'ifct2017',
  'indb',
  'usda',
  'openfoodfacts',
  'user',
] as const;
export const INGESTION_FOOD_SOURCES = ['ifct2017', 'indb'] as const;
export const ENERGY_SOURCES = [
  'source_kj',
  'source_kcal',
  'atwater_repair',
] as const;
export const SERVING_ORIGINS = [
  'fallback_100g',
  'source_dataset',
  'curated',
] as const;

export const foodAliasSchema = z.object({
  lang: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
});

export const servingEvidenceSchema = z.object({
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl: z.string().url(),
  sourceLocator: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(500).default(''),
});

export const servingBaseSchema = z.object({
  label: z.string().trim().min(1).max(80),
  grams: z.number().finite().positive().max(10_000),
  isDefault: z.boolean(),
  origin: z.enum(SERVING_ORIGINS),
  evidence: servingEvidenceSchema.nullable(),
});

export const servingSchema = servingBaseSchema
  .superRefine((serving, ctx) => {
    if (serving.origin !== 'fallback_100g' && serving.evidence === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'Source and curated servings require evidence',
      });
    }
    if (serving.origin === 'fallback_100g' && serving.evidence !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'The standard 100 g fallback does not take source evidence',
      });
    }
  });

export const macroSchema = z.object({
  kcal: z.number().finite().nonnegative().max(2_000),
  proteinG: z.number().finite().nonnegative().max(150),
  carbsG: z.number().finite().nonnegative().max(150),
  fatG: z.number().finite().nonnegative().max(150),
});

export const normalizedFoodSchema = z
  .object({
    externalId: z
      .string()
      .regex(/^(ifct|indb|usda|openfoodfacts|user):[A-Za-z0-9._-]+$/),
    name: z.string().trim().min(1).max(200),
    scientificName: z.string().trim().max(200).nullable(),
    aliases: z.array(foodAliasSchema),
    searchTerms: z.array(z.string().min(1)).min(1),
    group: z.string().trim().min(1).max(120),
    dietaryTags: z.array(z.string().trim().min(1).max(40)),
    per100g: macroSchema,
    servings: z.array(servingSchema).min(1),
    source: z.enum(FOOD_SOURCES),
    sourceName: z.string().trim().min(1).max(200),
    sourceVersion: z.string().trim().min(1).max(80),
    sourceUrl: z.string().url(),
    sourceAttribution: z.string().trim().min(1).max(200).nullable(),
    licence: z.string().trim().min(1).max(200),
    energySource: z.enum(ENERGY_SOURCES),
    verified: z.boolean(),
    isRecipe: z.boolean(),
  })
  .superRefine((food, ctx) => {
    const defaults = food.servings.filter((serving) => serving.isDefault);
    if (defaults.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['servings'],
        message: 'Exactly one serving must be the default',
      });
    }

    if (new Set(food.searchTerms).size !== food.searchTerms.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['searchTerms'],
        message: 'Search terms must be unique',
      });
    }

    const hasHundredGramServing = food.servings.some(
      (serving) =>
        Math.abs(serving.grams - 100) < 0.001 &&
        serving.label.toLowerCase().replace(/\s+/g, '') === '100g',
    );
    if (!hasHundredGramServing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['servings'],
        message: 'Every food must retain a 100 g serving',
      });
    }

    const servingLabels = food.servings.map((serving) =>
      serving.label.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim(),
    );
    if (new Set(servingLabels).size !== servingLabels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['servings'],
        message: 'Serving labels must be unique within a food',
      });
    }
  });

export type FoodSource = (typeof FOOD_SOURCES)[number];
export type IngestionFoodSource = (typeof INGESTION_FOOD_SOURCES)[number];
export type EnergySource = (typeof ENERGY_SOURCES)[number];
export type FoodAlias = z.infer<typeof foodAliasSchema>;
export type FoodServing = z.infer<typeof servingSchema>;
export type ServingEvidence = z.infer<typeof servingEvidenceSchema>;
export type FoodMacros = z.infer<typeof macroSchema>;
export type NormalizedFood = z.infer<typeof normalizedFoodSchema>;

export const rightsEntrySchema = z.object({
  sourceName: z.string().trim().min(1),
  sourceVersion: z.string().trim().min(1),
  sourceUrl: z.string().url(),
  licence: z.string().trim().min(1),
  approvedForCommercialRedistribution: z.boolean(),
  approvedBy: z.string().trim().min(1).nullable(),
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  evidenceUrl: z.string().url().nullable(),
  notes: z.string().trim().max(2_000).default(''),
});

export const rightsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.object({
    ifct2017: rightsEntrySchema,
    indb: rightsEntrySchema,
  }),
});

export type RightsEntry = z.infer<typeof rightsEntrySchema>;
export type RightsManifest = z.infer<typeof rightsManifestSchema>;

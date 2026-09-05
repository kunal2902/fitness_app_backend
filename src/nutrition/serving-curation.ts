import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  normalizedFoodSchema,
  servingBaseSchema,
  type NormalizedFood,
} from './food.schema.js';

const curatedServingSchema = servingBaseSchema
  .extend({
    origin: z.literal('curated'),
  })
  .superRefine((serving, ctx) => {
    if (serving.evidence === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'Curated servings require evidence',
      });
    }
  });

export const servingOverrideSchema = z.object({
  externalId: z.string().regex(/^(ifct|indb):[A-Za-z0-9._-]+$/),
  mode: z.enum(['append', 'replace']).default('append'),
  servings: z.array(curatedServingSchema).min(1),
});

export const servingCurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedBy: z.string().trim().min(1).nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    reviewNotes: z.string().trim().max(2_000).default(''),
    overrides: z.array(servingOverrideSchema),
  })
  .superRefine((curation, ctx) => {
    const ids = curation.overrides.map((override) => override.externalId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overrides'],
        message: 'Each externalId can appear only once',
      });
    }
    if ((curation.reviewedBy === null) !== (curation.reviewedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewedAt'],
        message: 'reviewedBy and reviewedAt must either both be set or both be null',
      });
    }
  });

export type ServingCuration = z.infer<typeof servingCurationSchema>;

export async function loadServingCuration(
  filePath: string,
): Promise<ServingCuration> {
  const raw = await readFile(filePath, 'utf8');
  return servingCurationSchema.parse(JSON.parse(raw));
}

export function assertServingCurationApproved(
  curation: ServingCuration,
): void {
  if (!curation.reviewedBy || !curation.reviewedAt) {
    throw new Error(
      'Serving overrides are not approved. A non-dry import requires ' +
        'reviewedBy and reviewedAt in the serving-curation JSON.',
    );
  }
}

function labelKey(label: string): string {
  return label.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

export function mergeServingCuration(
  foods: ReadonlyArray<NormalizedFood>,
  curation: ServingCuration,
): NormalizedFood[] {
  const overrideById = new Map(
    curation.overrides.map((override) => [override.externalId, override]),
  );
  const knownIds = new Set(foods.map((food) => food.externalId));
  const unknownIds = [...overrideById.keys()].filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `Serving curation references unknown food IDs: ${unknownIds.join(', ')}`,
    );
  }

  return foods.map((food) => {
    const override = overrideById.get(food.externalId);
    if (!override) return food;

    const curatedHasDefault = override.servings.some(
      (serving) => serving.isDefault,
    );
    const startingServings =
      override.mode === 'replace'
        ? []
        : food.servings.map((serving) => ({
            ...serving,
            isDefault: curatedHasDefault ? false : serving.isDefault,
          }));

    const mergedByLabel = new Map(
      startingServings.map((serving) => [labelKey(serving.label), serving]),
    );
    for (const serving of override.servings) {
      mergedByLabel.set(labelKey(serving.label), serving);
    }

    return normalizedFoodSchema.parse({
      ...food,
      servings: [...mergedByLabel.values()],
    });
  });
}

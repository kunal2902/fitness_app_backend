import { z } from 'zod';

import {
  LOADING_MODES,
  MOVEMENT_PATTERNS,
  MUSCLE_GROUPS,
  TRAINING_LEVELS,
  TRAINING_TYPES,
  trainingIdSchema,
} from '../training/catalogue.schema.js';

function csv<T extends z.ZodTypeAny>(item: T, maximum: number, allowEmpty = false) {
  return z.string().max(8_100).transform((value) => {
    if (allowEmpty && value === '') return [];
    return value.split(',').map((entry) => entry.trim());
  }).pipe(z.array(item).min(allowEmpty ? 0 : 1).max(maximum))
    .transform((values) => [...new Set(values)].sort());
}

function integerQuery(min: number, max: number) {
  return z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(min).max(max));
}

const sharedFields = {
  q: z.string().trim().min(1).max(120).optional(),
  muscles: csv(trainingIdSchema, 100).optional(),
  muscleGroups: csv(z.enum(MUSCLE_GROUPS), MUSCLE_GROUPS.length).optional(),
  muscleRole: z.enum(['primary', 'any']).default('any'),
  equipmentMode: z.enum(['available', 'uses']).optional(),
  equipmentIds: csv(trainingIdSchema, 100, true).optional(),
  equipmentProfileId: trainingIdSchema.optional(),
  difficulty: z.enum(TRAINING_LEVELS).optional(),
  trainingType: z.enum(TRAINING_TYPES).optional(),
  limit: integerQuery(1, 50).optional().transform((value) => value ?? 20),
  cursor: z.string().max(420).regex(/^[A-Za-z0-9_-]+$/).optional(),
};

type EquipmentFilters = {
  equipmentMode?: 'available' | 'uses';
  equipmentIds?: string[];
  equipmentProfileId?: string;
};

function validateEquipmentFilters(query: EquipmentFilters, context: z.RefinementCtx) {
  const issue = (field: keyof EquipmentFilters, message: string) =>
    context.addIssue({ code: 'custom', path: [field], message });

  if (query.equipmentProfileId !== undefined) {
    if (query.equipmentMode === 'uses') issue('equipmentMode', 'An equipment profile can only be used for compatibility');
    if (query.equipmentIds !== undefined) issue('equipmentIds', 'Choose explicit equipment or an equipment profile');
  } else if (query.equipmentMode === undefined && query.equipmentIds !== undefined) {
    issue('equipmentMode', 'Choose how to apply the equipment filter');
  } else if (query.equipmentMode !== undefined && query.equipmentIds === undefined) {
    issue('equipmentIds', 'Supply equipment IDs or an explicitly empty available set');
  } else if (query.equipmentMode === 'uses' && query.equipmentIds?.length === 0) {
    issue('equipmentIds', 'Choose at least one equipment item');
  }
}

export const exerciseDiscoveryQuerySchema = z.object({
  ...sharedFields,
  loadingMode: z.enum(LOADING_MODES).optional(),
  movementPattern: z.enum(MOVEMENT_PATTERNS).optional(),
  sort: z.enum(['relevance', 'name', 'difficulty']).default('relevance'),
}).strict().superRefine(validateEquipmentFilters);

export const workoutDiscoveryQuerySchema = z.object({
  ...sharedFields,
  maxDurationMin: integerQuery(1, 600).optional(),
  sort: z.enum(['relevance', 'name', 'difficulty', 'duration']).default('relevance'),
}).strict().superRefine(validateEquipmentFilters);

export const trainingDiscoveryParamsSchema = z.object({ id: trainingIdSchema }).strict();

export type ExerciseDiscoveryQuery = z.infer<typeof exerciseDiscoveryQuerySchema>;
export type WorkoutDiscoveryQuery = z.infer<typeof workoutDiscoveryQuerySchema>;

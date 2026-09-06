import { z } from 'zod';

import { MEAL_TYPES } from '../models/foodLog.model.js';
import { nutritionTargetSetupSchema } from '../nutrition/target-policy.js';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'That identifier is not valid');

export const diaryDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD format')
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    },
    'That calendar date is not valid',
  );

export const foodSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Enter a food to search').max(80),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const foodParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .refine(
      (value) =>
        /^[a-fA-F0-9]{24}$/.test(value) ||
        /^(ifct|indb|usda|openfoodfacts|user):[A-Za-z0-9._-]+$/.test(value),
      'That food identifier is not valid',
    ),
});

export const nutritionDateQuerySchema = z.object({
  date: diaryDateSchema,
});

export const nutritionLogItemSchema = z.object({
  foodId: objectIdSchema,
  grams: z.number().finite().positive().max(10_000),
  quantity: z.number().finite().positive().max(10_000),
  unitLabel: z.string().trim().min(1).max(80),
});

export const createNutritionLogSchema = z.object({
  date: diaryDateSchema,
  mealType: z.enum(MEAL_TYPES),
  items: z.array(nutritionLogItemSchema).min(1).max(50),
  clientId: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const updateNutritionLogSchema = z
  .object({
    date: diaryDateSchema.optional(),
    mealType: z.enum(MEAL_TYPES).optional(),
    items: z.array(nutritionLogItemSchema).min(1).max(50).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });

export const nutritionLogParamsSchema = z.object({
  id: objectIdSchema,
});

export const createSavedMealSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name for this meal').max(80),
  sourceDate: diaryDateSchema,
  sourceMealType: z.enum(MEAL_TYPES),
});

export const savedMealParamsSchema = z.object({
  id: objectIdSchema,
});

export const useSavedMealSchema = z.object({
  date: diaryDateSchema,
  mealType: z.enum(MEAL_TYPES),
  clientId: z.string().trim().min(1).max(64),
});

const targetFields = {
  kcal: z.number().finite().min(1_000).max(10_000),
  proteinG: z.number().finite().min(0).max(1_000),
  carbsG: z.number().finite().min(0).max(1_500),
  fatG: z.number().finite().min(0).max(500),
};

export const updateNutritionTargetSchema = z
  .object({
    kcal: targetFields.kcal.optional(),
    proteinG: targetFields.proteinG.optional(),
    carbsG: targetFields.carbsG.optional(),
    fatG: targetFields.fatG.optional(),
    setup: nutritionTargetSetupSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });

export type FoodSearchQuery = z.infer<typeof foodSearchQuerySchema>;
export type NutritionDateQuery = z.infer<typeof nutritionDateQuerySchema>;
export type NutritionLogItemInput = z.infer<typeof nutritionLogItemSchema>;
export type CreateNutritionLogInput = z.infer<typeof createNutritionLogSchema>;
export type UpdateNutritionLogInput = z.infer<typeof updateNutritionLogSchema>;
export type CreateSavedMealInput = z.infer<typeof createSavedMealSchema>;
export type UseSavedMealInput = z.infer<typeof useSavedMealSchema>;
export type UpdateNutritionTargetInput = z.infer<
  typeof updateNutritionTargetSchema
>;

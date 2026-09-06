import { Router } from 'express';

import {
  createNutritionLog,
  createSavedMeal,
  deleteNutritionLog,
  deleteSavedMeal,
  getFood,
  getNutritionSummary,
  getNutritionTargets,
  listNutritionLogs,
  listSavedMeals,
  logSavedMeal,
  searchFoods,
  updateNutritionLog,
  updateNutritionTargets,
  previewNutritionTargets,
} from '../controllers/nutrition.controller.js';
import { nutritionRecommendationSchema } from '../nutrition/target-policy.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  createNutritionLogSchema,
  createSavedMealSchema,
  foodParamsSchema,
  foodSearchQuerySchema,
  nutritionDateQuerySchema,
  nutritionLogParamsSchema,
  savedMealParamsSchema,
  updateNutritionLogSchema,
  updateNutritionTargetSchema,
  useSavedMealSchema,
} from '../validators/nutrition.validator.js';

const foods = Router();
foods.use(requireAuth);
foods.get('/search', validate(foodSearchQuerySchema, 'query'), searchFoods);
foods.get('/:id', validate(foodParamsSchema, 'params'), getFood);

const nutrition = Router();
nutrition.use(requireAuth);

nutrition.get('/logs', validate(nutritionDateQuerySchema, 'query'), listNutritionLogs);
nutrition.post('/logs', validate(createNutritionLogSchema), createNutritionLog);
nutrition.patch(
  '/logs/:id',
  validate(nutritionLogParamsSchema, 'params'),
  validate(updateNutritionLogSchema),
  updateNutritionLog,
);
nutrition.delete(
  '/logs/:id',
  validate(nutritionLogParamsSchema, 'params'),
  deleteNutritionLog,
);
nutrition.get('/saved-meals', listSavedMeals);
nutrition.post('/saved-meals', validate(createSavedMealSchema), createSavedMeal);
nutrition.delete(
  '/saved-meals/:id',
  validate(savedMealParamsSchema, 'params'),
  deleteSavedMeal,
);
nutrition.post(
  '/saved-meals/:id/log',
  validate(savedMealParamsSchema, 'params'),
  validate(useSavedMealSchema),
  logSavedMeal,
);
nutrition.get(
  '/summary',
  validate(nutritionDateQuerySchema, 'query'),
  getNutritionSummary,
);
nutrition.get('/targets', getNutritionTargets);
nutrition.post('/targets/recommendation', validate(nutritionRecommendationSchema), previewNutritionTargets);
nutrition.patch(
  '/targets',
  validate(updateNutritionTargetSchema),
  updateNutritionTargets,
);

export { foods, nutrition };

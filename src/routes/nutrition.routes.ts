import { Router } from 'express';

import {
  createNutritionLog,
  deleteNutritionLog,
  getFood,
  getNutritionSummary,
  getNutritionTargets,
  listNutritionLogs,
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
  foodParamsSchema,
  foodSearchQuerySchema,
  nutritionDateQuerySchema,
  nutritionLogParamsSchema,
  updateNutritionLogSchema,
  updateNutritionTargetSchema,
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

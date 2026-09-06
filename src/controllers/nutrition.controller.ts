import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { recommendNutritionTarget, type NutritionRecommendationInput } from '../nutrition/target-policy.js';

import { getValidated } from '../middleware/validate.middleware.js';
import { foodService } from '../services/food.service.js';
import { nutritionService } from '../services/nutrition.service.js';
import { savedMealService } from '../services/savedMeal.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type {
  CreateNutritionLogInput,
  CreateSavedMealInput,
  FoodSearchQuery,
  NutritionDateQuery,
  UpdateNutritionLogInput,
  UpdateNutritionTargetInput,
  UseSavedMealInput,
} from '../validators/nutrition.validator.js';

function requireUserId(req: Request): mongoose.Types.ObjectId {
  if (!req.user) throw ApiError.unauthorized();
  return req.user._id;
}

/** `GET /foods/search?q=&limit=` */
export const searchFoods = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const query = getValidated<FoodSearchQuery>(req);
    const result = await foodService.search({
      query: query.q,
      limit: query.limit,
      userId,
    });
    sendSuccess(res, result);
  },
);

/** `GET /foods/:id` — accepts a Mongo id or stable external id. */
export const getFood = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req);
  const { id } = getValidated<{ id: string }>(req);
  const food = await foodService.getById(id);
  sendSuccess(res, { food });
});

/** `GET /nutrition/logs?date=YYYY-MM-DD` */
export const listNutritionLogs = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { date } = getValidated<NutritionDateQuery>(req);
    const logs = await nutritionService.listLogs(userId, date);
    sendSuccess(res, { date, logs });
  },
);

/** `POST /nutrition/logs` */
export const createNutritionLog = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { log, isDuplicate } = await nutritionService.createLog(
      userId,
      req.body as CreateNutritionLogInput,
    );
    sendSuccess(
      res,
      { log, duplicate: isDuplicate },
      isDuplicate ? 200 : 201,
      isDuplicate ? 'Food log already saved' : 'Food logged',
    );
  },
);

/** `PATCH /nutrition/logs/:id` */
export const updateNutritionLog = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { id } = getValidated<{ id: string }>(req);
    const log = await nutritionService.updateLog(
      userId,
      id,
      req.body as UpdateNutritionLogInput,
    );
    sendSuccess(res, { log }, 200, 'Food log updated');
  },
);

/** `DELETE /nutrition/logs/:id` */
export const deleteNutritionLog = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { id } = getValidated<{ id: string }>(req);
    await nutritionService.deleteLog(userId, id);
    sendSuccess(res, { deleted: true }, 200, 'Food log deleted');
  },
);

/** `GET /nutrition/saved-meals` */
export const listSavedMeals = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const meals = await savedMealService.list(userId);
  sendSuccess(res, { meals });
});

/** `POST /nutrition/saved-meals` — snapshot one whole diary meal slot. */
export const createSavedMeal = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const meal = await savedMealService.createFromDiary(
    userId,
    req.body as CreateSavedMealInput,
  );
  sendSuccess(res, { meal }, 201, 'Meal saved for reuse');
});

/** `DELETE /nutrition/saved-meals/:id` */
export const deleteSavedMeal = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { id } = getValidated<{ id: string }>(req);
  await savedMealService.delete(userId, id);
  sendSuccess(res, { deleted: true }, 200, 'Saved meal deleted');
});

/** `POST /nutrition/saved-meals/:id/log` — reuse on any diary day/slot. */
export const logSavedMeal = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { id } = getValidated<{ id: string }>(req);
  const { log, isDuplicate } = await savedMealService.log(
    userId,
    id,
    req.body as UseSavedMealInput,
  );
  sendSuccess(
    res,
    { log, duplicate: isDuplicate },
    isDuplicate ? 200 : 201,
    isDuplicate ? 'Saved meal already added' : 'Saved meal added to diary',
  );
});

/** `GET /nutrition/summary?date=YYYY-MM-DD` */
export const getNutritionSummary = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { date } = getValidated<NutritionDateQuery>(req);
    const summary = await nutritionService.summary(userId, date);
    sendSuccess(res, { summary });
  },
);

/** `GET /nutrition/targets` */
export const getNutritionTargets = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const target = await nutritionService.getTarget(userId);
    sendSuccess(res, { target });
  },
);

/** `PATCH /nutrition/targets` */
export const updateNutritionTargets = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const target = await nutritionService.updateTarget(
      userId,
      req.body as UpdateNutritionTargetInput,
    );
    sendSuccess(res, { target }, 200, 'Nutrition targets updated');
  },
);

/** Authenticated, read-only calculation; persistence needs a separate save. */
export const previewNutritionTargets = asyncHandler(async (req: Request, res: Response) => {
  requireUserId(req);
  const recommendation = recommendNutritionTarget(req.body as NutritionRecommendationInput, {
    isProduction: env.isProduction,
    approvalVersion: env.nutritionTargetPolicyApproval,
  });
  sendSuccess(res, { recommendation });
});

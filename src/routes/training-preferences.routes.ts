import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { getTrainingPreferences, updateTrainingPreferences } from '../services/training-preferences.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { updateTrainingPreferencesSchema } from '../validators/training-preferences.validator.js';

export const trainingPreferences = Router();

trainingPreferences.get('/me/training-preferences', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  res.set('Cache-Control', 'private, no-store');
  sendSuccess(res, { preferences: await getTrainingPreferences(req.user) });
}));

trainingPreferences.patch('/me/training-preferences', requireAuth, validate(updateTrainingPreferencesSchema), asyncHandler(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  res.set('Cache-Control', 'private, no-store');
  sendSuccess(res, { preferences: await updateTrainingPreferences(req.user, req.body) });
}));

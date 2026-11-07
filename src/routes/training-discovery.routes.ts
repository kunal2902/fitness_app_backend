import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import { getValidated, validate } from '../middleware/validate.middleware.js';
import {
  getExerciseDetail,
  getTrainingTaxonomy,
  getWorkoutDetail,
  listExercises,
  listWorkouts,
} from '../services/training-discovery.service.js';
import { resolveEquipmentProfile } from '../services/training-preferences.service.js';
import { readActiveTrainingCatalogue } from '../training/catalogue-import.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  exerciseDiscoveryQuerySchema,
  trainingDiscoveryParamsSchema,
  workoutDiscoveryQuerySchema,
  type ExerciseDiscoveryQuery,
  type WorkoutDiscoveryQuery,
} from '../validators/training-discovery.validator.js';

async function requireActiveCatalogue() {
  const catalogue = await readActiveTrainingCatalogue();
  if (catalogue === null) {
    throw new ApiError(503, 'The training catalogue is not available yet', 'TRAINING_CATALOGUE_UNAVAILABLE');
  }
  return catalogue;
}

async function equipmentForRequest(req: Request, profileId: string | undefined) {
  if (profileId === undefined) return undefined;
  if (!req.userId) throw ApiError.unauthorized();
  return resolveEquipmentProfile(req.userId, profileId);
}

function sendCatalogueResponse(res: Response, data: unknown) {
  res.set('Cache-Control', 'private, no-store');
  sendSuccess(res, data);
}

export const trainingDiscovery = Router();

trainingDiscovery.get('/training/taxonomy', requireAuth, asyncHandler(async (_req, res) => {
  sendCatalogueResponse(res, getTrainingTaxonomy(await requireActiveCatalogue()));
}));

trainingDiscovery.get('/exercises', requireAuth, validate(exerciseDiscoveryQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const query = getValidated<ExerciseDiscoveryQuery>(req);
  const catalogue = await requireActiveCatalogue();
  const equipment = await equipmentForRequest(req, query.equipmentProfileId);
  sendCatalogueResponse(res, listExercises(catalogue, query, equipment));
}));

trainingDiscovery.get('/exercises/:id', requireAuth, validate(trainingDiscoveryParamsSchema, 'params'), asyncHandler(async (req, res) => {
  const { id } = getValidated<{ id: string }>(req);
  sendCatalogueResponse(res, getExerciseDetail(await requireActiveCatalogue(), id));
}));

trainingDiscovery.get('/workouts', requireAuth, validate(workoutDiscoveryQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const query = getValidated<WorkoutDiscoveryQuery>(req);
  const catalogue = await requireActiveCatalogue();
  const equipment = await equipmentForRequest(req, query.equipmentProfileId);
  sendCatalogueResponse(res, listWorkouts(catalogue, query, equipment));
}));

trainingDiscovery.get('/workouts/:id', requireAuth, validate(trainingDiscoveryParamsSchema, 'params'), asyncHandler(async (req, res) => {
  const { id } = getValidated<{ id: string }>(req);
  sendCatalogueResponse(res, getWorkoutDetail(await requireActiveCatalogue(), id));
}));

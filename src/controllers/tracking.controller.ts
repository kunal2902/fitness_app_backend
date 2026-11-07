import type { Request, Response } from 'express';
import mongoose from 'mongoose';

import { getValidated } from '../middleware/validate.middleware.js';
import { activityService, healthService } from '../services/tracking.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type {
  ActivityRangeQuery,
  CreateActivityInput,
  HealthRangeQuery,
  HealthSyncInput,
} from '../validators/tracking.validator.js';

function requireUserId(req: Request): mongoose.Types.ObjectId {
  if (!req.user) throw ApiError.unauthorized();
  return req.user._id;
}

/** `POST /activities` — idempotent when the same clientId is retried. */
export const createActivity = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { activity, isDuplicate } = await activityService.create(
    userId,
    req.body as CreateActivityInput,
  );
  sendSuccess(
    res,
    { activity, duplicate: isDuplicate },
    isDuplicate ? 200 : 201,
    isDuplicate ? 'Activity already saved' : 'Activity saved',
  );
});

/** `GET /activities?from=&to=&limit=` */
export const listActivities = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const range = getValidated<ActivityRangeQuery>(req);
  const activities = await activityService.list(userId, range);
  sendSuccess(res, { activities });
});

/** `GET /activities/:id` */
export const getActivity = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { id } = getValidated<{ id: string }>(req);
  const activity = await activityService.get(userId, id);
  sendSuccess(res, { activity });
});

/** `DELETE /activities/:id` */
export const deleteActivity = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { id } = getValidated<{ id: string }>(req);
  await activityService.delete(userId, id);
  sendSuccess(res, { deleted: true }, 200, 'Activity deleted');
});

/** `POST /health/sync` — upserts at most 1,000 user-local day summaries. */
export const syncHealth = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req);
  const { days } = req.body as HealthSyncInput;
  const synced = await healthService.sync(userId, days);
  sendSuccess(res, { days: synced, synced: synced.length }, 200, 'Health data synced');
});

/** `GET /health/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` */
export const listHealthDaily = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const range = getValidated<HealthRangeQuery>(req);
    const days = await healthService.list(userId, range);
    sendSuccess(res, { days });
  },
);

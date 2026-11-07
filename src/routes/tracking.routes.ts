import { Router } from 'express';

import {
  createActivity,
  deleteActivity,
  getActivity,
  listActivities,
  listHealthDaily,
  syncHealth,
} from '../controllers/tracking.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  activityParamsSchema,
  activityRangeQuerySchema,
  createActivitySchema,
  healthRangeQuerySchema,
  healthSyncSchema,
} from '../validators/tracking.validator.js';

const activities = Router();
activities.use(requireAuth);
activities.get('/', validate(activityRangeQuerySchema, 'query'), listActivities);
activities.post('/', validate(createActivitySchema), createActivity);
activities.get('/:id', validate(activityParamsSchema, 'params'), getActivity);
activities.delete('/:id', validate(activityParamsSchema, 'params'), deleteActivity);

const health = Router();
health.use(requireAuth);
health.post('/sync', validate(healthSyncSchema), syncHealth);
health.get('/daily', validate(healthRangeQuerySchema, 'query'), listHealthDaily);

export { activities, health };

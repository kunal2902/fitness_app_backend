import { Router } from 'express';
import mongoose from 'mongoose';

import {
  calls,
  conversations,
  devices,
  professionals,
} from './assistance.routes.js';
import authRoutes from './auth.routes.js';
import { env } from '../config/env.js';
import { foods, nutrition } from './nutrition.routes.js';
import { activities, health } from './tracking.routes.js';
import { trainingDiscovery } from './training-discovery.routes.js';
import { trainingPreferences } from './training-preferences.routes.js';
import userRoutes from './user.routes.js';

const router = Router();

/** Liveness + database check. Handy from the emulator to confirm reachability. */
router.get('/health', (_req, res) => {
  const states: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  res.json({
    success: true,
    data: {
      status: 'ok',
      database: states[mongoose.connection.readyState] ?? 'unknown',
      globalFoodSearch: env.foodDataCentral.apiKey ? 'enabled' : 'disabled',
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/professionals', professionals);
router.use('/conversations', conversations);
router.use('/calls', calls);
router.use('/devices', devices);
router.use('/foods', foods);
router.use('/nutrition', nutrition);
router.use('/activities', activities);
router.use('/health', health);
router.use(trainingDiscovery);
router.use(trainingPreferences);

// Later phases mount here:
// router.use('/community', communityRoutes);

export default router;

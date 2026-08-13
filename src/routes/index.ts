import { Router } from 'express';
import mongoose from 'mongoose';

import authRoutes from './auth.routes.js';

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
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

router.use('/auth', authRoutes);

// Phase 2 mounts here:
// router.use('/workouts', workoutRoutes);
// router.use('/community', communityRoutes);

export default router;

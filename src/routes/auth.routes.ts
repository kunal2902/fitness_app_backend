import { Router } from 'express';

import {
  checkAvailability,
  login,
  logout,
  me,
  refresh,
  signup,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  authLimiter,
  availabilityLimiter,
} from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  availabilitySchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  signupSchema,
} from '../validators/auth.validator.js';

const router = Router();

router.post('/signup', authLimiter, validate(signupSchema), signup);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', validate(refreshSchema), refresh);
router.post('/logout', validate(logoutSchema), logout);

router.get(
  '/check-availability',
  availabilityLimiter,
  validate(availabilitySchema, 'query'),
  checkAvailability,
);

router.get('/me', requireAuth, me);

export default router;

import rateLimit from 'express-rate-limit';

import { env } from '../config/env.js';

/**
 * Signup and login are the two endpoints worth brute-forcing, so they get
 * their own tighter buckets. Limits are relaxed in development so testing
 * the flow repeatedly does not lock you out.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please wait a few minutes and try again.',
    code: 'RATE_LIMITED',
  },
});

/** Called on every keystroke-ish, so it needs a much higher ceiling. */
export const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isProduction ? 60 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Slow down a moment.',
    code: 'RATE_LIMITED',
  },
});

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isProduction ? 200 : 2000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

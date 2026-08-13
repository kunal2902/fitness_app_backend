import { z } from 'zod';

import {
  DIP_RANGES,
  FITNESS_GOALS,
  FITNESS_LEVELS,
  GENDERS,
  HEIGHT_UNITS,
  PULLUP_RANGES,
  PUSHUP_RANGES,
  SQUAT_RANGES,
  WEIGHT_UNITS,
} from '../models/user.model.js';

/**
 * These rules mirror `lib/utils/validators.dart` on the client. The client
 * copy is for instant feedback; this one is the authority.
 */

const username = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(20, 'At most 20 characters')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._]*$/, 'Letters, numbers, dot and underscore only')
  .refine((v) => !v.endsWith('.') && !v.endsWith('_'), {
    message: 'Cannot end with a dot or underscore',
  })
  .refine((v) => !v.includes('..') && !v.includes('__'), {
    message: 'No repeated dots or underscores',
  })
  .transform((v) => v.toLowerCase());

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email')
  .email('That email does not look right')
  .transform((v) => v.toLowerCase());

const password = z
  .string()
  .min(8, 'At least 8 characters')
  .max(64, 'At most 64 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

const fullName = z
  .string()
  .trim()
  .min(2, 'That looks too short')
  .max(60, 'At most 60 characters')
  .regex(/[A-Za-z]/, 'Use letters, not just symbols');

export const fitnessProfileSchema = z.object({
  gender: z.enum(GENDERS),
  heightCm: z.number().min(120, 'Height looks too low').max(230, 'Height looks too high'),
  heightUnit: z.enum(HEIGHT_UNITS).default('cm'),
  weightKg: z.number().min(30, 'Weight looks too low').max(200, 'Weight looks too high'),
  weightUnit: z.enum(WEIGHT_UNITS).default('kg'),
  goals: z
    .array(z.enum(FITNESS_GOALS))
    .min(1, 'Pick at least one goal')
    .max(3, 'Pick at most three goals'),
  maxPullUps: z.enum(PULLUP_RANGES),
  maxPushUps: z.enum(PUSHUP_RANGES),
  maxSquats: z.enum(SQUAT_RANGES),
  maxDips: z.enum(DIP_RANGES),
  fitnessLevel: z.enum(FITNESS_LEVELS),
});

export const signupSchema = z.object({
  username,
  fullName,
  email,
  password,
  fitnessProfile: fitnessProfileSchema,
});

export const loginSchema = z.object({
  /** Username or email — we work out which. */
  identifier: z.string().trim().min(1, 'Enter your username or email'),
  password: z.string().min(1, 'Enter your password'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Missing refresh token'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().optional(),
});

export const availabilitySchema = z
  .object({
    username: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.username || v.email), {
    message: 'Provide a username or an email to check',
  });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

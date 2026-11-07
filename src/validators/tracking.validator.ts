import { z } from 'zod';

import {
  ACTIVITY_SOURCES,
  ACTIVITY_TYPES,
} from '../models/activity.model.js';
import { HEALTH_SOURCES } from '../models/healthDaily.model.js';
import { decodePolyline } from '../tracking/polyline.js';
import { diaryDateSchema } from './nutrition.validator.js';

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{24}$/, 'That identifier is not valid');

const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO 8601 timestamp with timezone' });

const nullableMetric = (minimum: number, maximum: number) =>
  z.number().finite().min(minimum).max(maximum).nullable().optional();

const encodedPolylineSchema = z
  .string()
  .max(200_000)
  .superRefine((encoded, context) => {
    if (encoded.length === 0) return;
    try {
      decodePolyline(encoded);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Route geometry is not a valid precision-5 encoded polyline',
      });
    }
  });

export const activitySplitSchema = z
  .object({
    index: z.number().int().min(1).max(10_000),
    distanceM: z.number().finite().min(0).max(5_000_000),
    durationSec: z.number().int().min(0).max(604_800),
    movingSec: z.number().int().min(0).max(604_800),
    paceSecPerKm: nullableMetric(0, 86_400),
    isPartial: z.boolean(),
  })
  .strict()
  .superRefine((split, context) => {
    if (split.movingSec > split.durationSec) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['movingSec'],
        message: 'Moving time cannot exceed split duration',
      });
    }
  });

export const createActivitySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    startedAt: instantSchema,
    endedAt: instantSchema,
    durationSec: z.number().int().min(0).max(604_800),
    movingSec: z.number().int().min(0).max(604_800),
    distanceM: z.number().finite().min(0).max(5_000_000),
    elevationGainM: nullableMetric(0, 100_000),
    avgPaceSecPerKm: nullableMetric(0, 86_400),
    encodedPolyline: encodedPolylineSchema,
    splits: z.array(activitySplitSchema).max(10_000),
    calories: z.number().finite().min(0).max(100_000),
    avgHr: nullableMetric(20, 260),
    maxHr: nullableMetric(20, 260),
    source: z.enum(ACTIVITY_SOURCES),
    clientId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((activity, context) => {
    const started = new Date(activity.startedAt);
    const ended = new Date(activity.endedAt);
    if (ended <= started) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'End time must be after start time',
      });
    }
    const wallClockSec = (ended.getTime() - started.getTime()) / 1000;
    if (activity.durationSec > wallClockSec + 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationSec'],
        message: 'Duration cannot exceed the start-to-end interval',
      });
    }
    if (activity.movingSec > activity.durationSec) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['movingSec'],
        message: 'Moving time cannot exceed duration',
      });
    }
    if (
      activity.avgHr != null &&
      activity.maxHr != null &&
      activity.avgHr > activity.maxHr
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxHr'],
        message: 'Maximum heart rate cannot be below average heart rate',
      });
    }
    if (activity.source !== 'manual' && !activity.clientId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clientId'],
        message: 'Synced activities need a clientId for safe retries',
      });
    }
    activity.splits.forEach((split, index) => {
      if (split.index !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['splits', index, 'index'],
          message: 'Split indexes must be consecutive from 1',
        });
      }
    });
    if (activity.splits.length > 0) {
      const splitDistance = activity.splits.reduce(
        (total, split) => total + split.distanceM,
        0,
      );
      const toleranceM = Math.max(2, activity.distanceM * 0.005);
      if (Math.abs(splitDistance - activity.distanceM) > toleranceM) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['splits'],
          message: 'Split distances must add up to the activity distance',
        });
      }
    }
  });

export const activityParamsSchema = z.object({ id: objectIdSchema }).strict();

export const activityRangeQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((range, context) => {
    if ((range.from === undefined) !== (range.to === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [range.from === undefined ? 'from' : 'to'],
        message: 'Supply both from and to, or neither',
      });
      return;
    }
    if (!range.from || !range.to) return;
    const from = new Date(range.from);
    const to = new Date(range.to);
    if (to < from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to must be on or after from',
      });
    } else if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Activity ranges cannot exceed 366 days',
      });
    }
  });

export const healthDailyInputSchema = z
  .object({
    date: diaryDateSchema,
    steps: z.number().int().min(0).max(1_000_000),
    activeKcal: z.number().finite().min(0).max(100_000),
    restingHr: nullableMetric(20, 260),
    spo2: nullableMetric(0, 100),
    vo2Max: nullableMetric(0, 150),
    weightKg: nullableMetric(1, 500),
    source: z.enum(HEALTH_SOURCES),
  })
  .strict();

export const healthSyncSchema = z
  .object({
    days: z.array(healthDailyInputSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((sync, context) => {
    const seen = new Set<string>();
    sync.days.forEach((day, index) => {
      if (seen.has(day.date)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['days', index, 'date'],
          message: 'Each date can appear only once per sync',
        });
      }
      seen.add(day.date);
    });
  });

export const healthRangeQuerySchema = z
  .object({
    from: diaryDateSchema,
    to: diaryDateSchema,
  })
  .strict()
  .superRefine((range, context) => {
    if (range.to < range.from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to must be on or after from',
      });
      return;
    }
    const from = new Date(`${range.from}T00:00:00.000Z`);
    const to = new Date(`${range.to}T00:00:00.000Z`);
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Health ranges cannot exceed 366 days',
      });
    }
  });

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type ActivityRangeQuery = z.infer<typeof activityRangeQuerySchema>;
export type HealthDailyInput = z.infer<typeof healthDailyInputSchema>;
export type HealthSyncInput = z.infer<typeof healthSyncSchema>;
export type HealthRangeQuery = z.infer<typeof healthRangeQuerySchema>;

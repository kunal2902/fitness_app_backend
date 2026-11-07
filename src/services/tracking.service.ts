import mongoose from 'mongoose';

import {
  Activity,
  toPublicActivity,
  type ActivityDocument,
  type PublicActivity,
} from '../models/activity.model.js';
import {
  HealthDaily,
  toPublicHealthDaily,
  type PublicHealthDaily,
} from '../models/healthDaily.model.js';
import { ApiError } from '../utils/apiError.js';
import {
  createRouteThumbnail,
  deleteRouteThumbnail,
} from '../tracking/route-thumbnail.store.js';
import type {
  ActivityRangeQuery,
  CreateActivityInput,
  HealthDailyInput,
  HealthRangeQuery,
} from '../validators/tracking.validator.js';

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

async function findDuplicateActivity(
  userId: mongoose.Types.ObjectId,
  clientId: string | undefined,
): Promise<ActivityDocument | null> {
  return clientId ? Activity.findOne({ userId, clientId }) : null;
}

export const activityService = {
  async create(
    userId: mongoose.Types.ObjectId,
    input: CreateActivityInput,
  ): Promise<{ activity: PublicActivity; isDuplicate: boolean }> {
    const existing = await findDuplicateActivity(userId, input.clientId);
    if (existing) {
      return { activity: toPublicActivity(existing), isDuplicate: true };
    }

    const activityId = new mongoose.Types.ObjectId();
    let thumbnailUrl: string | null = null;
    let activity: ActivityDocument;
    try {
      thumbnailUrl = await createRouteThumbnail(
        activityId.toString(),
        input.encodedPolyline,
        input.splits,
      );
      activity = await Activity.create({
        _id: activityId,
        userId,
        ...input,
        thumbnailUrl,
        elevationGainM: input.elevationGainM ?? null,
        avgPaceSecPerKm: input.avgPaceSecPerKm ?? null,
        avgHr: input.avgHr ?? null,
        maxHr: input.maxHr ?? null,
        clientId: input.clientId ?? null,
      });
    } catch (error) {
      await deleteRouteThumbnail(thumbnailUrl).catch(() => undefined);
      if (duplicateKey(error) && input.clientId) {
        const raced = await Activity.findOne({ userId, clientId: input.clientId });
        if (raced) {
          return { activity: toPublicActivity(raced), isDuplicate: true };
        }
      }
      throw error;
    }
    return { activity: toPublicActivity(activity), isDuplicate: false };
  },

  async list(
    userId: mongoose.Types.ObjectId,
    range: ActivityRangeQuery,
  ): Promise<PublicActivity[]> {
    const filter: Record<string, unknown> = { userId };
    if (range.from && range.to) {
      filter.startedAt = {
        $gte: new Date(range.from),
        $lte: new Date(range.to),
      };
    }
    const activities = await Activity.find(filter)
      .sort({ startedAt: -1, _id: -1 })
      .limit(range.limit);
    return activities.map(toPublicActivity);
  },

  async get(
    userId: mongoose.Types.ObjectId,
    activityId: string,
  ): Promise<PublicActivity> {
    const activity = await Activity.findOne({ _id: activityId, userId });
    if (!activity) throw ApiError.notFound('Activity not found', 'NO_ACTIVITY');
    return toPublicActivity(activity);
  },

  async delete(userId: mongoose.Types.ObjectId, activityId: string): Promise<void> {
    const deleted = await Activity.findOneAndDelete({ _id: activityId, userId });
    if (!deleted) throw ApiError.notFound('Activity not found', 'NO_ACTIVITY');
    await deleteRouteThumbnail(deleted.thumbnailUrl).catch((error: unknown) => {
      console.error('Could not delete route thumbnail', error);
    });
  },
};

export const healthService = {
  async sync(
    userId: mongoose.Types.ObjectId,
    days: ReadonlyArray<HealthDailyInput>,
  ): Promise<PublicHealthDaily[]> {
    await HealthDaily.bulkWrite(
      days.map((day) => {
        const set = {
          steps: day.steps,
          activeKcal: day.activeKcal,
          source: day.source,
          ...(day.restingHr === undefined
            ? {}
            : { restingHr: day.restingHr }),
          ...(day.spo2 === undefined
            ? {}
            : { spo2: day.spo2 }),
          ...(day.vo2Max === undefined
            ? {}
            : { vo2Max: day.vo2Max }),
          ...(day.weightKg === undefined
            ? {}
            : { weightKg: day.weightKg }),
        };
        return {
          updateOne: {
            filter: { userId, date: day.date },
            update: {
              $setOnInsert: { userId, date: day.date },
              $set: set,
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );

    const synced = await HealthDaily.find({
      userId,
      date: { $in: days.map((day) => day.date) },
    }).sort({ date: 1 });
    return synced.map(toPublicHealthDaily);
  },

  async list(
    userId: mongoose.Types.ObjectId,
    range: HealthRangeQuery,
  ): Promise<PublicHealthDaily[]> {
    const days = await HealthDaily.find({
      userId,
      date: { $gte: range.from, $lte: range.to },
    }).sort({ date: 1 });
    return days.map(toPublicHealthDaily);
  },
};

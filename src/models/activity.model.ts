import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const ACTIVITY_TYPES = [
  'run',
  'walk',
  'hike',
  'cycle',
  'other',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_SOURCES = ['app', 'healthconnect', 'manual'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export interface IActivitySplit {
  index: number;
  distanceM: number;
  durationSec: number;
  movingSec: number;
  paceSecPerKm?: number | null;
  isPartial: boolean;
}

export interface IActivity {
  userId: mongoose.Types.ObjectId;
  type: ActivityType;
  startedAt: Date;
  endedAt: Date;
  /** Stopwatch time, including pauses. */
  durationSec: number;
  movingSec: number;
  /** Canonical distance. Display conversions never enter persistence. */
  distanceM: number;
  elevationGainM?: number | null;
  avgPaceSecPerKm?: number | null;
  encodedPolyline: string;
  /** Public, immutable PNG generated once from the stored route. */
  thumbnailUrl?: string | null;
  splits: IActivitySplit[];
  calories: number;
  avgHr?: number | null;
  maxHr?: number | null;
  source: ActivitySource;
  clientId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ActivityDocument = HydratedDocument<IActivity>;

const integer = {
  validator: Number.isInteger,
  message: '{PATH} must be a whole number',
};

const activitySplitSchema = new Schema<IActivitySplit>(
  {
    index: { type: Number, required: true, min: 1, validate: integer },
    distanceM: { type: Number, required: true, min: 0, max: 5_000_000 },
    durationSec: {
      type: Number,
      required: true,
      min: 0,
      max: 604_800,
      validate: integer,
    },
    movingSec: {
      type: Number,
      required: true,
      min: 0,
      max: 604_800,
      validate: integer,
    },
    paceSecPerKm: { type: Number, default: null, min: 0, max: 86_400 },
    isPartial: { type: Boolean, required: true },
  },
  { _id: false },
);

const activitySchema = new Schema<IActivity>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    durationSec: {
      type: Number,
      required: true,
      min: 0,
      max: 604_800,
      validate: integer,
    },
    movingSec: {
      type: Number,
      required: true,
      min: 0,
      max: 604_800,
      validate: integer,
    },
    distanceM: { type: Number, required: true, min: 0, max: 5_000_000 },
    elevationGainM: { type: Number, default: null, min: 0, max: 100_000 },
    avgPaceSecPerKm: { type: Number, default: null, min: 0, max: 86_400 },
    encodedPolyline: { type: String, required: true, default: '', maxlength: 500_000 },
    thumbnailUrl: { type: String, default: null, maxlength: 300 },
    splits: {
      type: [activitySplitSchema],
      required: true,
      default: [],
      validate: {
        validator: (splits: IActivitySplit[]) => splits.length <= 10_000,
        message: 'An activity can contain at most 10,000 splits',
      },
    },
    calories: { type: Number, required: true, min: 0, max: 100_000 },
    avgHr: { type: Number, default: null, min: 20, max: 260 },
    maxHr: { type: Number, default: null, min: 20, max: 260 },
    source: { type: String, enum: ACTIVITY_SOURCES, required: true },
    clientId: { type: String, default: null, minlength: 1, maxlength: 64 },
  },
  {
    collection: 'activities',
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
  },
);

activitySchema.pre('validate', function validateRelationships() {
  if (this.endedAt <= this.startedAt) {
    this.invalidate('endedAt', 'endedAt must be after startedAt');
  }
  if (this.movingSec > this.durationSec) {
    this.invalidate('movingSec', 'movingSec cannot exceed durationSec');
  }
  if (this.avgHr != null && this.maxHr != null && this.avgHr > this.maxHr) {
    this.invalidate('maxHr', 'maxHr cannot be below avgHr');
  }
  if (this.source !== 'manual' && !this.clientId) {
    this.invalidate('clientId', 'clientId is required for synced activities');
  }
  for (let i = 0; i < this.splits.length; i += 1) {
    const split = this.splits[i];
    if (!split) continue;
    if (split.index !== i + 1) {
      this.invalidate('splits', 'Split indexes must be consecutive from 1');
      break;
    }
    if (split.movingSec > split.durationSec) {
      this.invalidate('splits', 'Split moving time cannot exceed duration');
      break;
    }
  }
});

activitySchema.index({ userId: 1, startedAt: -1, _id: -1 });
activitySchema.index(
  { userId: 1, clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientId: { $type: 'string' } },
    name: 'activity_idempotency',
  },
);

export const Activity: Model<IActivity> =
  (mongoose.models.Activity as Model<IActivity> | undefined) ??
  mongoose.model<IActivity>('Activity', activitySchema);

export interface PublicActivity {
  id: string;
  type: ActivityType;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  movingSec: number;
  distanceM: number;
  elevationGainM: number | null;
  avgPaceSecPerKm: number | null;
  encodedPolyline: string;
  thumbnailUrl: string | null;
  splits: IActivitySplit[];
  calories: number;
  avgHr: number | null;
  maxHr: number | null;
  source: ActivitySource;
  clientId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicActivity(activity: ActivityDocument): PublicActivity {
  return {
    id: activity._id.toString(),
    type: activity.type,
    startedAt: activity.startedAt.toISOString(),
    endedAt: activity.endedAt.toISOString(),
    durationSec: activity.durationSec,
    movingSec: activity.movingSec,
    distanceM: activity.distanceM,
    elevationGainM: activity.elevationGainM ?? null,
    avgPaceSecPerKm: activity.avgPaceSecPerKm ?? null,
    encodedPolyline: activity.encodedPolyline,
    thumbnailUrl: activity.thumbnailUrl ?? null,
    splits: activity.splits.map((split) => ({
      index: split.index,
      distanceM: split.distanceM,
      durationSec: split.durationSec,
      movingSec: split.movingSec,
      paceSecPerKm: split.paceSecPerKm ?? null,
      isPartial: split.isPartial,
    })),
    calories: activity.calories,
    avgHr: activity.avgHr ?? null,
    maxHr: activity.maxHr ?? null,
    source: activity.source,
    clientId: activity.clientId ?? null,
    createdAt: activity.createdAt.toISOString(),
    updatedAt: activity.updatedAt.toISOString(),
  };
}

import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const HEALTH_SOURCES = ['healthconnect', 'healthkit', 'manual'] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

export interface IHealthDaily {
  userId: mongoose.Types.ObjectId;
  /** User-local calendar date. It intentionally has no timezone. */
  date: string;
  steps: number;
  activeKcal: number;
  restingHr?: number | null;
  spo2?: number | null;
  vo2Max?: number | null;
  /** Canonical weight. Pounds are a display-only conversion. */
  weightKg?: number | null;
  source: HealthSource;
  createdAt: Date;
  updatedAt: Date;
}

export type HealthDailyDocument = HydratedDocument<IHealthDaily>;

const integer = {
  validator: Number.isInteger,
  message: '{PATH} must be a whole number',
};

const healthDailySchema = new Schema<IHealthDaily>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    steps: {
      type: Number,
      required: true,
      min: 0,
      max: 1_000_000,
      validate: integer,
    },
    activeKcal: { type: Number, required: true, min: 0, max: 100_000 },
    restingHr: { type: Number, default: null, min: 20, max: 260 },
    spo2: { type: Number, default: null, min: 0, max: 100 },
    vo2Max: { type: Number, default: null, min: 0, max: 150 },
    weightKg: { type: Number, default: null, min: 1, max: 500 },
    source: { type: String, enum: HEALTH_SOURCES, required: true },
  },
  {
    collection: 'health_daily',
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
  },
);

healthDailySchema.index(
  { userId: 1, date: 1 },
  { unique: true, name: 'health_daily_per_user_date' },
);

export const HealthDaily: Model<IHealthDaily> =
  (mongoose.models.HealthDaily as Model<IHealthDaily> | undefined) ??
  mongoose.model<IHealthDaily>('HealthDaily', healthDailySchema);

export interface PublicHealthDaily {
  date: string;
  steps: number;
  activeKcal: number;
  restingHr: number | null;
  spo2: number | null;
  vo2Max: number | null;
  weightKg: number | null;
  source: HealthSource;
  updatedAt: string;
}

export function toPublicHealthDaily(
  daily: HealthDailyDocument,
): PublicHealthDaily {
  return {
    date: daily.date,
    steps: daily.steps,
    activeKcal: daily.activeKcal,
    restingHr: daily.restingHr ?? null,
    spo2: daily.spo2 ?? null,
    vo2Max: daily.vo2Max ?? null,
    weightKg: daily.weightKg ?? null,
    source: daily.source,
    updatedAt: daily.updatedAt.toISOString(),
  };
}

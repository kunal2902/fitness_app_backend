import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import { ACTIVITY_LEVELS, TARGET_GOALS, type NutritionTargetSetup } from '../nutrition/target-policy.js';

export interface INutritionTarget {
  userId: mongoose.Types.ObjectId;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  setup?: NutritionTargetSetup;
  createdAt: Date;
  updatedAt: Date;
}

export type NutritionTargetDocument = HydratedDocument<INutritionTarget>;

const setupSchema = new Schema<NutritionTargetSetup>({
  age: { type: Number, required: true, min: 18, max: 78, validate: Number.isInteger },
  gender: { type: String, required: true, enum: ['male', 'female'] },
  heightCm: { type: Number, required: true, min: 120, max: 230 },
  weightKg: { type: Number, required: true, min: 30, max: 200 },
  activityLevel: { type: String, required: true, enum: ACTIVITY_LEVELS },
  goal: { type: String, required: true, enum: TARGET_GOALS },
}, { _id: false });

const nutritionTargetSchema = new Schema<INutritionTarget>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    kcal: { type: Number, required: true, min: 1_000, max: 10_000 },
    proteinG: { type: Number, required: true, min: 0, max: 1_000 },
    carbsG: { type: Number, required: true, min: 0, max: 1_500 },
    fatG: { type: Number, required: true, min: 0, max: 500 },
    setup: { type: setupSchema, required: false },
  },
  {
    collection: 'nutrition_targets',
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
  },
);

export const NutritionTarget: Model<INutritionTarget> =
  (mongoose.models.NutritionTarget as Model<INutritionTarget> | undefined) ??
  mongoose.model<INutritionTarget>('NutritionTarget', nutritionTargetSchema);

export interface PublicNutritionTarget {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  updatedAt: string;
  setup?: NutritionTargetSetup;
}

export function toPublicNutritionTarget(
  target: NutritionTargetDocument,
): PublicNutritionTarget {
  return {
    kcal: target.kcal,
    proteinG: target.proteinG,
    carbsG: target.carbsG,
    fatG: target.fatG,
    updatedAt: target.updatedAt.toISOString(),
    ...(target.setup ? { setup: {
      age: target.setup.age,
      gender: target.setup.gender,
      heightCm: target.setup.heightCm,
      weightKg: target.setup.weightKg,
      activityLevel: target.setup.activityLevel,
      goal: target.setup.goal,
    } } : {}),
  };
}

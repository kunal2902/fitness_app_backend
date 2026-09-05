import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import { FOOD_SOURCES, type FoodMacros, type FoodSource } from '../nutrition/food.schema.js';
import { macrosForGrams, type MacroTotals } from '../nutrition/nutrition-math.js';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export interface IFoodSnapshot {
  externalId: string;
  name: string;
  per100g: FoodMacros;
  source: FoodSource;
  sourceVersion: string;
}

export interface IFoodLogItem {
  foodId: mongoose.Types.ObjectId;
  grams: number;
  quantity: number;
  unitLabel: string;
  snapshot: IFoodSnapshot;
}

export interface IFoodLog {
  userId: mongoose.Types.ObjectId;
  /** User-local diary day. Stored without a timezone by design. */
  date: string;
  mealType: MealType;
  items: IFoodLogItem[];
  clientId?: string | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FoodLogDocument = HydratedDocument<IFoodLog>;

const macroSnapshotSchema = new Schema<FoodMacros>(
  {
    kcal: { type: Number, required: true, min: 0 },
    proteinG: { type: Number, required: true, min: 0 },
    carbsG: { type: Number, required: true, min: 0 },
    fatG: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const foodSnapshotSchema = new Schema<IFoodSnapshot>(
  {
    externalId: { type: String, required: true },
    name: { type: String, required: true },
    per100g: { type: macroSnapshotSchema, required: true },
    source: { type: String, enum: FOOD_SOURCES, required: true },
    sourceVersion: { type: String, required: true },
  },
  { _id: false },
);

const foodLogItemSchema = new Schema<IFoodLogItem>(
  {
    foodId: { type: Schema.Types.ObjectId, ref: 'Food', required: true },
    grams: { type: Number, required: true, min: 0.01, max: 10_000 },
    quantity: { type: Number, required: true, min: 0.01, max: 10_000 },
    unitLabel: { type: String, required: true, trim: true, maxlength: 80 },
    snapshot: { type: foodSnapshotSchema, required: true },
  },
  { _id: false },
);

const foodLogSchema = new Schema<IFoodLog>(
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
      index: true,
    },
    mealType: { type: String, enum: MEAL_TYPES, required: true },
    items: {
      type: [foodLogItemSchema],
      required: true,
      validate: {
        validator: (items: IFoodLogItem[]) => items.length > 0 && items.length <= 50,
        message: 'A food log must contain between 1 and 50 items',
      },
    },
    clientId: { type: String, default: null, maxlength: 64 },
    notes: { type: String, default: null, maxlength: 500 },
  },
  {
    collection: 'food_logs',
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
  },
);

foodLogSchema.index({ userId: 1, date: 1, mealType: 1, createdAt: 1 });
foodLogSchema.index(
  { userId: 1, clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientId: { $type: 'string' } },
    name: 'food_log_idempotency',
  },
);
foodLogSchema.index({ userId: 1, 'items.foodId': 1, createdAt: -1 });

export const FoodLog: Model<IFoodLog> =
  (mongoose.models.FoodLog as Model<IFoodLog> | undefined) ??
  mongoose.model<IFoodLog>('FoodLog', foodLogSchema);

export interface PublicFoodLogItem {
  foodId: string;
  grams: number;
  quantity: number;
  unitLabel: string;
  snapshot: IFoodSnapshot;
  macros: MacroTotals;
}

export interface PublicFoodLog {
  id: string;
  date: string;
  mealType: MealType;
  items: PublicFoodLogItem[];
  clientId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicFoodLog(log: FoodLogDocument): PublicFoodLog {
  return {
    id: log._id.toString(),
    date: log.date,
    mealType: log.mealType,
    items: log.items.map((item) => ({
      foodId: item.foodId.toString(),
      grams: item.grams,
      quantity: item.quantity,
      unitLabel: item.unitLabel,
      snapshot: {
        externalId: item.snapshot.externalId,
        name: item.snapshot.name,
        per100g: {
          kcal: item.snapshot.per100g.kcal,
          proteinG: item.snapshot.per100g.proteinG,
          carbsG: item.snapshot.per100g.carbsG,
          fatG: item.snapshot.per100g.fatG,
        },
        source: item.snapshot.source,
        sourceVersion: item.snapshot.sourceVersion,
      },
      macros: macrosForGrams(item.snapshot.per100g, item.grams),
    })),
    clientId: log.clientId ?? null,
    notes: log.notes ?? null,
    createdAt: log.createdAt.toISOString(),
    updatedAt: log.updatedAt.toISOString(),
  };
}

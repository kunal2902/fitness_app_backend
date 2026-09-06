import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import {
  MEAL_TYPES,
  foodLogItemSchema,
  toPublicFoodLogItem,
  type IFoodLogItem,
  type MealType,
  type PublicFoodLogItem,
} from './foodLog.model.js';
import { sumMacros, type MacroTotals } from '../nutrition/nutrition-math.js';

export interface ISavedMeal {
  userId: mongoose.Types.ObjectId;
  name: string;
  normalizedName: string;
  defaultMealType: MealType;
  items: IFoodLogItem[];
  useCount: number;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SavedMealDocument = HydratedDocument<ISavedMeal>;

const savedMealSchema = new Schema<ISavedMeal>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    normalizedName: { type: String, required: true, trim: true, maxlength: 80 },
    defaultMealType: { type: String, enum: MEAL_TYPES, required: true },
    items: {
      type: [foodLogItemSchema],
      required: true,
      validate: {
        validator: (items: IFoodLogItem[]) => items.length > 0 && items.length <= 50,
        message: 'A saved meal must contain between 1 and 50 items',
      },
    },
    useCount: { type: Number, required: true, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  {
    collection: 'saved_meals',
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
  },
);

savedMealSchema.index(
  { userId: 1, normalizedName: 1 },
  { unique: true, name: 'saved_meal_name_per_user' },
);
savedMealSchema.index({ userId: 1, lastUsedAt: -1, updatedAt: -1 });

export const SavedMeal: Model<ISavedMeal> =
  (mongoose.models.SavedMeal as Model<ISavedMeal> | undefined) ??
  mongoose.model<ISavedMeal>('SavedMeal', savedMealSchema);

export interface PublicSavedMeal {
  id: string;
  name: string;
  defaultMealType: MealType;
  items: PublicFoodLogItem[];
  totals: MacroTotals;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicSavedMeal(meal: SavedMealDocument): PublicSavedMeal {
  const items = meal.items.map(toPublicFoodLogItem);
  return {
    id: meal._id.toString(),
    name: meal.name,
    defaultMealType: meal.defaultMealType,
    items,
    totals: sumMacros(items.map((item) => item.macros)),
    useCount: meal.useCount,
    lastUsedAt: meal.lastUsedAt?.toISOString() ?? null,
    createdAt: meal.createdAt.toISOString(),
    updatedAt: meal.updatedAt.toISOString(),
  };
}

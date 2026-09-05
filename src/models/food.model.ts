import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import {
  ENERGY_SOURCES,
  FOOD_SOURCES,
  SERVING_ORIGINS,
  type EnergySource,
  type FoodAlias,
  type FoodMacros,
  type FoodServing,
  type FoodSource,
} from '../nutrition/food.schema.js';

export interface IFood {
  externalId: string;
  name: string;
  scientificName?: string | null;
  aliases: FoodAlias[];
  searchTerms: string[];
  group: string;
  dietaryTags: string[];
  per100g: FoodMacros;
  servings: FoodServing[];
  source: FoodSource;
  sourceName: string;
  sourceVersion: string;
  sourceUrl: string;
  sourceAttribution?: string | null;
  licence: string;
  energySource: EnergySource;
  verified: boolean;
  isRecipe: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type FoodDocument = HydratedDocument<IFood>;

const aliasSchema = new Schema<FoodAlias>(
  {
    lang: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const macroSchema = new Schema<FoodMacros>(
  {
    kcal: { type: Number, required: true, min: 0 },
    proteinG: { type: Number, required: true, min: 0 },
    carbsG: { type: Number, required: true, min: 0 },
    fatG: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const evidenceSchema = new Schema(
  {
    sourceName: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    sourceLocator: { type: String, required: true, trim: true },
    notes: { type: String, default: '' },
  },
  { _id: false },
);

const servingSchema = new Schema<FoodServing>(
  {
    label: { type: String, required: true, trim: true },
    grams: { type: Number, required: true, min: 0.01, max: 10_000 },
    isDefault: { type: Boolean, required: true },
    origin: { type: String, enum: SERVING_ORIGINS, required: true },
    evidence: { type: evidenceSchema, default: null },
  },
  { _id: false },
);

const foodSchema = new Schema<IFood>(
  {
    externalId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    scientificName: { type: String, default: null, trim: true },
    aliases: { type: [aliasSchema], default: [] },
    searchTerms: { type: [String], required: true, default: [] },
    group: { type: String, required: true, trim: true },
    dietaryTags: { type: [String], default: [] },
    per100g: { type: macroSchema, required: true },
    servings: { type: [servingSchema], required: true },
    source: { type: String, enum: FOOD_SOURCES, required: true, index: true },
    sourceName: { type: String, required: true, trim: true },
    sourceVersion: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    sourceAttribution: { type: String, default: null },
    licence: { type: String, required: true, trim: true },
    energySource: { type: String, enum: ENERGY_SOURCES, required: true },
    verified: { type: Boolean, default: false, index: true },
    isRecipe: { type: Boolean, default: false, index: true },
  },
  {
    collection: 'foods',
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

foodSchema.index(
  { name: 'text', searchTerms: 'text' },
  { weights: { name: 10, searchTerms: 5 }, name: 'food_search_text' },
);
foodSchema.index({ source: 1, isRecipe: -1, name: 1 });

export const Food: Model<IFood> =
  (mongoose.models.Food as Model<IFood> | undefined) ??
  mongoose.model<IFood>('Food', foodSchema);

export interface PublicFood {
  id: string;
  externalId: string;
  name: string;
  scientificName: string | null;
  aliases: FoodAlias[];
  group: string;
  dietaryTags: string[];
  per100g: FoodMacros;
  servings: FoodServing[];
  source: FoodSource;
  sourceName: string;
  sourceVersion: string;
  sourceAttribution: string | null;
  licence: string;
  energySource: EnergySource;
  verified: boolean;
  isRecipe: boolean;
}

export function toPublicFood(food: FoodDocument): PublicFood {
  return {
    id: food._id.toString(),
    externalId: food.externalId,
    name: food.name,
    scientificName: food.scientificName ?? null,
    aliases: food.aliases.map((alias) => ({ lang: alias.lang, name: alias.name })),
    group: food.group,
    dietaryTags: [...food.dietaryTags],
    per100g: {
      kcal: food.per100g.kcal,
      proteinG: food.per100g.proteinG,
      carbsG: food.per100g.carbsG,
      fatG: food.per100g.fatG,
    },
    servings: food.servings.map((serving) => ({
      label: serving.label,
      grams: serving.grams,
      isDefault: serving.isDefault,
      origin: serving.origin,
      evidence: serving.evidence
        ? {
            sourceName: serving.evidence.sourceName,
            sourceUrl: serving.evidence.sourceUrl,
            sourceLocator: serving.evidence.sourceLocator,
            notes: serving.evidence.notes,
          }
        : null,
    })),
    source: food.source,
    sourceName: food.sourceName,
    sourceVersion: food.sourceVersion,
    sourceAttribution: food.sourceAttribution ?? null,
    licence: food.licence,
    energySource: food.energySource,
    verified: food.verified,
    isRecipe: food.isRecipe,
  };
}

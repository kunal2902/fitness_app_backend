import mongoose from 'mongoose';

import { Food, type FoodDocument } from '../models/food.model.js';
import {
  FoodLog,
  MEAL_TYPES,
  toPublicFoodLog,
  type FoodLogDocument,
  type IFoodLogItem,
  type IFoodSnapshot,
  type MealType,
  type PublicFoodLog,
} from '../models/foodLog.model.js';
import {
  NutritionTarget,
  toPublicNutritionTarget,
  type PublicNutritionTarget,
} from '../models/nutritionTarget.model.js';
import {
  isMatchingGramAmount,
  macrosForGrams,
  servingQuantityToGrams,
  sumMacros,
  type MacroTotals,
} from '../nutrition/nutrition-math.js';
import { ApiError } from '../utils/apiError.js';
import type {
  CreateNutritionLogInput,
  NutritionLogItemInput,
  UpdateNutritionLogInput,
  UpdateNutritionTargetInput,
} from '../validators/nutrition.validator.js';

function labelKey(value: string): string {
  return value.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

function expectedItemGrams(
  food: FoodDocument,
  item: NutritionLogItemInput,
): number {
  const requested = labelKey(item.unitLabel);
  const serving = food.servings.find(
    (candidate) => labelKey(candidate.label) === requested,
  );
  if (serving) return servingQuantityToGrams(serving.grams, item.quantity);
  if (['g', 'gram', 'grams'].includes(requested)) return item.quantity;
  throw ApiError.validation({
    unitLabel: `${item.unitLabel} is not a serving for ${food.name}`,
  });
}

async function resolveItems(
  inputs: ReadonlyArray<NutritionLogItemInput>,
  existingItems: ReadonlyArray<IFoodLogItem> = [],
): Promise<IFoodLogItem[]> {
  const ids = [...new Set(inputs.map((item) => item.foodId))];
  const foods = await Food.find({ _id: { $in: ids } });
  const byId = new Map(foods.map((food) => [food._id.toString(), food]));
  // One log can contain the same food more than once. Consume matching
  // snapshots in order so every existing occurrence keeps the composition
  // frozen when it was first logged.
  const preservedByFood = new Map<string, IFoodLogItem[]>();
  for (const existing of existingItems) {
    const key = existing.foodId.toString();
    const matches = preservedByFood.get(key) ?? [];
    matches.push(existing);
    preservedByFood.set(key, matches);
  }

  return inputs.map((item) => {
    const food = byId.get(item.foodId);
    const preserved = preservedByFood.get(item.foodId)?.shift();
    if (!food && !preserved) {
      throw ApiError.validation({ foodId: 'One of those foods no longer exists' });
    }
    let expectedGrams: number;
    if (food) {
      expectedGrams = expectedItemGrams(food, item);
    } else if (
      preserved &&
      preserved.quantity > 0 &&
      labelKey(preserved.unitLabel) === labelKey(item.unitLabel)
    ) {
      expectedGrams = servingQuantityToGrams(
        preserved.grams / preserved.quantity,
        item.quantity,
      );
    } else {
      throw ApiError.validation({
        unitLabel: 'That historical food is unavailable; keep its original serving',
      });
    }
    if (!isMatchingGramAmount(item.grams, expectedGrams)) {
      throw ApiError.validation({
        grams:
          `${item.quantity} × ${item.unitLabel} for ${food?.name ?? preserved?.snapshot.name ?? 'that food'} is ` +
          `${expectedGrams} g, not ${item.grams} g`,
      });
    }

    const snapshot: IFoodSnapshot = preserved
      ? {
          externalId: preserved.snapshot.externalId,
          name: preserved.snapshot.name,
          per100g: {
            kcal: preserved.snapshot.per100g.kcal,
            proteinG: preserved.snapshot.per100g.proteinG,
            carbsG: preserved.snapshot.per100g.carbsG,
            fatG: preserved.snapshot.per100g.fatG,
          },
          source: preserved.snapshot.source,
          sourceVersion: preserved.snapshot.sourceVersion,
        }
      : {
          externalId: food!.externalId,
          name: food!.name,
          per100g: {
            kcal: food!.per100g.kcal,
            proteinG: food!.per100g.proteinG,
            carbsG: food!.per100g.carbsG,
            fatG: food!.per100g.fatG,
          },
          source: food!.source,
          sourceVersion: food!.sourceVersion,
        };

    return {
      foodId: food?._id ?? preserved!.foodId,
      grams: expectedGrams,
      quantity: item.quantity,
      unitLabel: item.unitLabel,
      snapshot,
    };
  });
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

type ResolvedLogInput = Pick<
  CreateNutritionLogInput,
  'date' | 'mealType' | 'clientId' | 'notes'
>;

async function findDuplicateLog(
  userId: mongoose.Types.ObjectId,
  clientId: string | undefined,
): Promise<FoodLogDocument | null> {
  return clientId ? FoodLog.findOne({ userId, clientId }) : null;
}

async function createResolvedLog(
  userId: mongoose.Types.ObjectId,
  input: ResolvedLogInput,
  items: IFoodLogItem[],
): Promise<{ log: PublicFoodLog; isDuplicate: boolean }> {
  let log: FoodLogDocument;
  try {
    log = await FoodLog.create({
      userId,
      date: input.date,
      mealType: input.mealType,
      items,
      clientId: input.clientId ?? null,
      notes: input.notes ?? null,
    });
  } catch (error) {
    if (duplicateKey(error) && input.clientId) {
      const raced = await FoodLog.findOne({ userId, clientId: input.clientId });
      if (raced) return { log: toPublicFoodLog(raced), isDuplicate: true };
    }
    throw error;
  }
  return { log: toPublicFoodLog(log), isDuplicate: false };
}

export interface MealSummary {
  mealType: MealType;
  totals: MacroTotals;
  logCount: number;
  itemCount: number;
}

export function buildDailySummary(logs: ReadonlyArray<PublicFoodLog>): {
  totals: MacroTotals;
  meals: MealSummary[];
} {
  const meals = MEAL_TYPES.map((mealType) => {
    const mealLogs = logs.filter((log) => log.mealType === mealType);
    const items = mealLogs.flatMap((log) => log.items);
    return {
      mealType,
      totals: sumMacros(items.map((item) => macrosForGrams(item.snapshot.per100g, item.grams))),
      logCount: mealLogs.length,
      itemCount: items.length,
    };
  });
  return { totals: sumMacros(meals.map((meal) => meal.totals)), meals };
}

export const nutritionService = {
  async listLogs(
    userId: mongoose.Types.ObjectId,
    date: string,
  ): Promise<PublicFoodLog[]> {
    const logs = await FoodLog.find({ userId, date }).sort({ createdAt: 1 });
    return logs.map(toPublicFoodLog);
  },

  async createLog(
    userId: mongoose.Types.ObjectId,
    input: CreateNutritionLogInput,
  ): Promise<{ log: PublicFoodLog; isDuplicate: boolean }> {
    const existing = await findDuplicateLog(userId, input.clientId);
    if (existing) return { log: toPublicFoodLog(existing), isDuplicate: true };

    const items = await resolveItems(input.items);
    return createResolvedLog(userId, input, items);
  },

  /**
   * Creates a normal diary log from snapshots already owned by the server.
   * This is intentionally not exposed to request payloads: it lets reusable
   * meals preserve the nutrition the member reviewed when saving the template,
   * even if the source catalogue is later corrected or removed.
   */
  async createLogFromServerSnapshot(
    userId: mongoose.Types.ObjectId,
    input: ResolvedLogInput & { items: IFoodLogItem[] },
  ): Promise<{ log: PublicFoodLog; isDuplicate: boolean }> {
    const existing = await findDuplicateLog(userId, input.clientId);
    if (existing) return { log: toPublicFoodLog(existing), isDuplicate: true };
    return createResolvedLog(userId, input, input.items);
  },

  async updateLog(
    userId: mongoose.Types.ObjectId,
    logId: string,
    input: UpdateNutritionLogInput,
  ): Promise<PublicFoodLog> {
    const log = await FoodLog.findOne({ _id: logId, userId });
    if (!log) throw ApiError.notFound('Food log not found', 'NO_FOOD_LOG');

    if (input.date !== undefined) log.date = input.date;
    if (input.mealType !== undefined) log.mealType = input.mealType;
    if (input.notes !== undefined) log.notes = input.notes;
    if (input.items !== undefined) {
      log.items = await resolveItems(input.items, log.items);
    }
    await log.save();
    return toPublicFoodLog(log);
  },

  async deleteLog(
    userId: mongoose.Types.ObjectId,
    logId: string,
  ): Promise<void> {
    const deleted = await FoodLog.findOneAndDelete({ _id: logId, userId });
    if (!deleted) throw ApiError.notFound('Food log not found', 'NO_FOOD_LOG');
  },

  async summary(userId: mongoose.Types.ObjectId, date: string) {
    const [logs, target] = await Promise.all([
      this.listLogs(userId, date),
      NutritionTarget.findOne({ userId }),
    ]);
    return {
      date,
      ...buildDailySummary(logs),
      target: target ? toPublicNutritionTarget(target) : null,
    };
  },

  async getTarget(
    userId: mongoose.Types.ObjectId,
  ): Promise<PublicNutritionTarget | null> {
    const target = await NutritionTarget.findOne({ userId });
    return target ? toPublicNutritionTarget(target) : null;
  },

  async updateTarget(
    userId: mongoose.Types.ObjectId,
    input: UpdateNutritionTargetInput,
  ): Promise<PublicNutritionTarget> {
    const missing = ['kcal', 'proteinG', 'carbsG', 'fatG'].filter(
      (key) => input[key as keyof UpdateNutritionTargetInput] === undefined,
    );
    // Atomic field-level patches avoid lost updates and duplicate-key races
    // when two devices finish initial setup together. No recommendation is
    // ever applied without an explicit user save.
    const options = { new: true, runValidators: true, upsert: missing.length === 0 };
    let target;
    try {
      target = await NutritionTarget.findOneAndUpdate(
        { userId }, { $set: input }, options,
      );
    } catch (error) {
      if (!duplicateKey(error) || missing.length !== 0) throw error;
      target = await NutritionTarget.findOneAndUpdate(
        { userId }, { $set: input }, { new: true, runValidators: true },
      );
    }
    if (!target) {
      throw ApiError.validation(
        Object.fromEntries(missing.map((key) => [key, 'Required for initial targets'])),
        'Set all four nutrition targets the first time',
      );
    }
    return toPublicNutritionTarget(target);
  },
};

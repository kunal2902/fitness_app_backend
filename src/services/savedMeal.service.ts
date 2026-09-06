import mongoose from 'mongoose';

import { FoodLog, type IFoodLogItem } from '../models/foodLog.model.js';
import {
  SavedMeal,
  toPublicSavedMeal,
  type PublicSavedMeal,
} from '../models/savedMeal.model.js';
import { ApiError } from '../utils/apiError.js';
import type {
  CreateSavedMealInput,
  UseSavedMealInput,
} from '../validators/nutrition.validator.js';
import { nutritionService } from './nutrition.service.js';

const MAX_SAVED_MEALS = 100;

function normalizedName(value: string): string {
  return value.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

function cloneItem(item: IFoodLogItem): IFoodLogItem {
  return {
    foodId: new mongoose.Types.ObjectId(item.foodId.toString()),
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
  };
}

export const savedMealService = {
  async list(userId: mongoose.Types.ObjectId): Promise<PublicSavedMeal[]> {
    const meals = await SavedMeal.find({ userId }).sort({
      lastUsedAt: -1,
      updatedAt: -1,
      name: 1,
    });
    return meals.map(toPublicSavedMeal);
  },

  async createFromDiary(
    userId: mongoose.Types.ObjectId,
    input: CreateSavedMealInput,
  ): Promise<PublicSavedMeal> {
    const logs = await FoodLog.find({
      userId,
      date: input.sourceDate,
      mealType: input.sourceMealType,
    }).sort({ createdAt: 1 });
    const items = logs.flatMap((log) => log.items.map(cloneItem));
    if (items.length === 0) {
      throw ApiError.validation(
        { sourceMealType: 'That meal has no foods to save' },
        'Add at least one food before saving this meal',
      );
    }
    if (items.length > 50) {
      throw ApiError.validation(
        { sourceMealType: 'A saved meal can contain at most 50 foods' },
        'This meal is too large to save as one template',
      );
    }
    if ((await SavedMeal.countDocuments({ userId })) >= MAX_SAVED_MEALS) {
      throw ApiError.badRequest(
        `You can keep up to ${MAX_SAVED_MEALS} saved meals`,
        'SAVED_MEAL_LIMIT',
      );
    }

    try {
      const meal = await SavedMeal.create({
        userId,
        name: input.name,
        normalizedName: normalizedName(input.name),
        defaultMealType: input.sourceMealType,
        items,
      });
      return toPublicSavedMeal(meal);
    } catch (error) {
      if (duplicateKey(error)) {
        throw ApiError.conflict(
          'You already have a saved meal with that name',
          'SAVED_MEAL_NAME_TAKEN',
          { name: 'Choose a different saved-meal name' },
        );
      }
      throw error;
    }
  },

  async delete(userId: mongoose.Types.ObjectId, mealId: string): Promise<void> {
    const deleted = await SavedMeal.findOneAndDelete({ _id: mealId, userId });
    if (!deleted) throw ApiError.notFound('Saved meal not found', 'NO_SAVED_MEAL');
  },

  async log(
    userId: mongoose.Types.ObjectId,
    mealId: string,
    input: UseSavedMealInput,
  ) {
    const meal = await SavedMeal.findOne({ _id: mealId, userId });
    if (!meal) throw ApiError.notFound('Saved meal not found', 'NO_SAVED_MEAL');

    const result = await nutritionService.createLogFromServerSnapshot(userId, {
      date: input.date,
      mealType: input.mealType,
      clientId: input.clientId,
      items: meal.items.map(cloneItem),
    });
    if (!result.isDuplicate) {
      // Reuse metadata is informational. A failed counter update must not turn a
      // successfully-created diary log into an apparent failure that the client
      // may retry.
      await SavedMeal.updateOne(
        { _id: meal._id, userId },
        { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
      ).catch(() => undefined);
    }
    return result;
  },
};

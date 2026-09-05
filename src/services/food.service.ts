import mongoose from 'mongoose';

import {
  Food,
  toPublicFood,
  type FoodDocument,
  type PublicFood,
} from '../models/food.model.js';
import { FoodLog } from '../models/foodLog.model.js';
import type { NormalizedFood } from '../nutrition/food.schema.js';
import { normalizeSearchTerm } from '../nutrition/food-transform.js';
import { ApiError } from '../utils/apiError.js';
import { usdaFoodDataService } from './usda-food-data.service.js';

interface FrecencyRow {
  _id: mongoose.Types.ObjectId;
  count: number;
  lastUsedAt: Date;
}

// A sparse local result should be augmented once, but it should not consume
// another upstream request on every keystroke or repeat search. The foods
// themselves remain persistently cached in Mongo; this small process-local
// TTL only records that a query has already had a chance to fill its page.
const GLOBAL_EXPANSION_TTL_MS = 30 * 60 * 1000;
const GLOBAL_EXPANSION_CACHE_LIMIT = 1_000;
const globallyExpandedUntil = new Map<string, number>();

function globalExpansionIsFresh(query: string, now = Date.now()): boolean {
  const key = normalizeSearchTerm(query);
  const expiresAt = globallyExpandedUntil.get(key) ?? 0;
  if (expiresAt > now) return true;
  globallyExpandedUntil.delete(key);
  return false;
}

function markGlobalExpansion(query: string, now = Date.now()): void {
  if (globallyExpandedUntil.size >= GLOBAL_EXPANSION_CACHE_LIMIT) {
    for (const [key, expiresAt] of globallyExpandedUntil) {
      if (expiresAt <= now) globallyExpandedUntil.delete(key);
    }
    if (globallyExpandedUntil.size >= GLOBAL_EXPANSION_CACHE_LIMIT) {
      const oldestKey = globallyExpandedUntil.keys().next().value as
        | string
        | undefined;
      if (oldestKey) globallyExpandedUntil.delete(oldestKey);
    }
  }
  globallyExpandedUntil.set(
    normalizeSearchTerm(query),
    now + GLOBAL_EXPANSION_TTL_MS,
  );
}

function escapedRegex(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function findCandidates(
  query: string,
  candidateLimit: number,
): Promise<FoodDocument[]> {
  let candidates = await Food.find(
    { verified: true, $text: { $search: query } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(candidateLimit);

  // Mongo text search is token based and does not match a partial first
  // word such as "alm". The bounded fallback keeps type-ahead useful.
  if (candidates.length === 0) {
    const pattern = escapedRegex(query);
    candidates = await Food.find({
      verified: true,
      $or: [{ name: pattern }, { searchTerms: pattern }],
    })
      .sort({ isRecipe: -1, name: 1 })
      .limit(candidateLimit);
  }
  return candidates;
}

async function cacheGlobalFoods(foods: ReadonlyArray<NormalizedFood>) {
  if (foods.length === 0) return;
  const now = new Date();
  await Food.bulkWrite(
    foods.map((food) => ({
      updateOne: {
        filter: { externalId: food.externalId },
        update: {
          $set: { ...food, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export function calculateFrecencyScore(
  count: number,
  lastUsedAt: Date,
  now = new Date(),
): number {
  const ageDays = Math.max(
    0,
    (now.getTime() - lastUsedAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  const recency = 12 / (1 + ageDays / 7);
  const frequency = Math.log1p(Math.max(count, 0)) * 4;
  return recency + frequency;
}

export const foodService = {
  async search(params: {
    query: string;
    limit: number;
    userId: mongoose.Types.ObjectId;
  }): Promise<{
    foods: PublicFood[];
    query: string;
    /**
     * True when there are no searchable foods at all.
     *
     * Without this, an unimported catalogue is indistinguishable from a
     * genuine miss, and the app tells the user their search term is wrong
     * when the real answer is that no food data has been loaded yet.
     * Computed only on the empty path, so a normal search pays nothing.
    */
    catalogueEmpty?: boolean;
    /** True when a local miss could not be expanded through USDA. */
    globalLookupUnavailable?: boolean;
  }> {
    const query = params.query.trim();
    const candidateLimit = Math.min(Math.max(params.limit * 4, 40), 200);

    let candidates = await findCandidates(query, candidateLimit);
    let globalLookupUnavailable = false;

    // USDA augments a sparse local page, not only a total miss. Mongo text
    // search can return one weak token match (for example "protein") and
    // previously that prevented useful global results from ever appearing.
    // A successful expansion is normalized and persisted, so meal logs still
    // reference server-owned Mongo ids and subsequent searches stay local.
    if (
      candidates.length < params.limit &&
      !globalExpansionIsFresh(query)
    ) {
      const global = await usdaFoodDataService.search(query, params.limit);
      globalLookupUnavailable = global.status !== 'success';
      if (global.status === 'success') markGlobalExpansion(query);
      if (global.foods.length > 0) {
        await cacheGlobalFoods(global.foods);
        candidates = await findCandidates(query, candidateLimit);
      }
    }

    if (candidates.length === 0) {
      // `exists` rather than a count: it stops at the first hit and uses
      // the `verified` index.
      const anyFood = await Food.exists({ verified: true });
      return {
        foods: [],
        query,
        catalogueEmpty: anyFood === null,
        ...(globalLookupUnavailable ? { globalLookupUnavailable: true } : {}),
      };
    }

    const ids = candidates.map((food) => food._id);
    const recent = await FoodLog.aggregate<FrecencyRow>([
      {
        $match: {
          userId: params.userId,
          createdAt: {
            $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.foodId': { $in: ids } } },
      {
        $group: {
          _id: '$items.foodId',
          count: { $sum: 1 },
          lastUsedAt: { $max: '$createdAt' },
        },
      },
    ]);
    const frecency = new Map(
      recent.map((row) => [
        row._id.toString(),
        calculateFrecencyScore(row.count, row.lastUsedAt),
      ]),
    );
    const baseOrder = new Map(
      candidates.map((food, index) => [food._id.toString(), index]),
    );

    candidates.sort((left, right) => {
      const rank =
        (frecency.get(right._id.toString()) ?? 0) -
        (frecency.get(left._id.toString()) ?? 0);
      if (rank !== 0) return rank;
      return (
        (baseOrder.get(left._id.toString()) ?? 0) -
        (baseOrder.get(right._id.toString()) ?? 0)
      );
    });

    return {
      foods: candidates.slice(0, params.limit).map(toPublicFood),
      query,
    };
  },

  async getById(id: string): Promise<PublicFood> {
    const food = mongoose.Types.ObjectId.isValid(id)
      ? await Food.findById(id)
      : await Food.findOne({ externalId: id });
    if (!food) throw ApiError.notFound('Food not found', 'NO_FOOD');
    return toPublicFood(food);
  },
};

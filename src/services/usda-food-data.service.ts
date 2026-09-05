import { env } from '../config/env.js';
import { normalizeSearchTerm } from '../nutrition/food-transform.js';
import {
  transformUsdaSearchResponse,
} from '../nutrition/usda-food-data.js';
import type { NormalizedFood } from '../nutrition/food.schema.js';

export type GlobalFoodLookupStatus =
  | 'disabled'
  | 'success'
  | 'unavailable';

export interface GlobalFoodLookupResult {
  foods: NormalizedFood[];
  status: GlobalFoodLookupStatus;
  rejectedCount: number;
}

const inFlight = new Map<string, Promise<GlobalFoodLookupResult>>();
let unavailableUntil = 0;
const OUTAGE_BACKOFF_MS = 60_000;

async function fetchPage(
  query: string,
  pageSize: number,
  dataType: ReadonlyArray<string>,
): Promise<{ foods: NormalizedFood[]; rejectedCount: number }> {
  const url = new URL(
    'foods/search',
    `${env.foodDataCentral.baseUrl.replace(/\/$/, '')}/`,
  );
  // The key is server-only. Never return this URL or the upstream error to
  // a device, because either could expose it.
  url.searchParams.set('api_key', env.foodDataCentral.apiKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      pageSize,
      pageNumber: 1,
      dataType,
    }),
    signal: AbortSignal.timeout(env.foodDataCentral.timeoutMs),
  });
  if (!response.ok) throw new Error(`FoodData Central returned ${response.status}`);
  const transformed = transformUsdaSearchResponse(await response.json());
  return {
    foods: transformed.foods,
    rejectedCount: transformed.errors.length,
  };
}

async function fetchFoods(
  query: string,
  limit: number,
): Promise<GlobalFoodLookupResult> {
  if (!env.foodDataCentral.apiKey) {
    return { foods: [], status: 'disabled', rejectedCount: 0 };
  }
  if (Date.now() < unavailableUntil) {
    return { foods: [], status: 'unavailable', rejectedCount: 0 };
  }

  try {
    const pageSize = Math.min(Math.max(limit * 2, 20), 50);
    // Generic composition records are substantially less repetitive than
    // contributed label rows, so they lead broad searches such as "oats".
    const generic = await fetchPage(
      query,
      pageSize,
      ['Foundation', 'SR Legacy', 'Survey (FNDDS)'],
    );
    let foods = generic.foods;
    let rejectedCount = generic.rejectedCount;
    // A specific brand often has no generic equivalent. Query labels only
    // when the generic result set cannot fill the requested page.
    if (foods.length < limit) {
      try {
        const branded = await fetchPage(query, pageSize, ['Branded']);
        const existing = new Set(foods.map((food) => food.externalId));
        foods = [
          ...foods,
          ...branded.foods.filter((food) => !existing.has(food.externalId)),
        ];
        rejectedCount += branded.rejectedCount;
      } catch {
        // Partial generic coverage is more useful than turning the complete
        // request into an outage. With zero usable generic rows, propagate so
        // the circuit breaker protects the upstream.
        if (foods.length === 0) throw new Error('Branded lookup unavailable');
      }
    }
    unavailableUntil = 0;
    return {
      foods,
      status: 'success',
      rejectedCount,
    };
  } catch {
    // Local food search must keep working during an upstream outage. A short
    // circuit break prevents every member's miss from hammering the service.
    unavailableUntil = Date.now() + OUTAGE_BACKOFF_MS;
    return { foods: [], status: 'unavailable', rejectedCount: 0 };
  }
}

export const usdaFoodDataService = {
  async search(query: string, limit: number): Promise<GlobalFoodLookupResult> {
    const key = normalizeSearchTerm(query);
    if (key.length < 2) {
      return { foods: [], status: 'success', rejectedCount: 0 };
    }
    const current = inFlight.get(key);
    if (current) return current;

    const request = fetchFoods(query, limit).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  },
};

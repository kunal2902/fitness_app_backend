/** Optional live contract check. Requires FDC_API_KEY and never writes MongoDB. */
import assert from 'node:assert/strict';

import { usdaFoodDataService } from '../src/services/usda-food-data.service.js';

const queries = ['oats', 'whey protein', 'greek yogurt'] as const;

if (!process.env.FDC_API_KEY) {
  throw new Error(
    'FDC_API_KEY is required. Obtain a server-side data.gov key or use ' +
      'DEMO_KEY only for this low-volume development check.',
  );
}

console.log('\nUSDA FoodData Central live verification\n');
for (const query of queries) {
  const result = await usdaFoodDataService.search(query, 10);
  assert.equal(result.status, 'success', `${query}: USDA lookup was unavailable`);
  assert.ok(result.foods.length > 0, `${query}: no valid macro result returned`);
  const first = result.foods[0]!;
  console.log(
    `  ✓ ${query}: ${result.foods.length} valid result(s); ` +
      `first is ${first.name} (${first.externalId})`,
  );
}
console.log('\nLive verification passed. No database records were written.\n');

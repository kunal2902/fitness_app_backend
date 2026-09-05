import type { FoodMacros } from './food.schema.js';

export interface MacroTotals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export const ZERO_MACROS: MacroTotals = {
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
};

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Scales a frozen per-100 g snapshot to the mass actually eaten. */
export function macrosForGrams(
  per100g: FoodMacros,
  grams: number,
): MacroTotals {
  const factor = grams / 100;
  return {
    kcal: round(per100g.kcal * factor),
    proteinG: round(per100g.proteinG * factor),
    carbsG: round(per100g.carbsG * factor),
    fatG: round(per100g.fatG * factor),
  };
}

export function sumMacros(
  values: ReadonlyArray<MacroTotals>,
): MacroTotals {
  return values.reduce<MacroTotals>(
    (total, value) => ({
      kcal: round(total.kcal + value.kcal),
      proteinG: round(total.proteinG + value.proteinG),
      carbsG: round(total.carbsG + value.carbsG),
      fatG: round(total.fatG + value.fatG),
    }),
    { ...ZERO_MACROS },
  );
}

/** Canonical portion calculation shared by request validation and tests. */
export function servingQuantityToGrams(
  servingGrams: number,
  quantity: number,
): number {
  if (!Number.isFinite(servingGrams) || servingGrams <= 0) {
    throw new Error('Serving grams must be positive');
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Serving quantity must be positive');
  }
  return round(servingGrams * quantity);
}

export function isMatchingGramAmount(
  suppliedGrams: number,
  expectedGrams: number,
): boolean {
  const tolerance = Math.max(0.1, expectedGrams * 0.01);
  return Math.abs(suppliedGrams - expectedGrams) <= tolerance;
}

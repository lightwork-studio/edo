import type { FoodNutrition } from "./nutrition.ts";

export type FoodProvider = "bls" | "open-food-facts" | "usda" | "local";

/** Source IDs are strings so leading zeros and provider-specific keys survive. */
export interface FoodId {
  readonly provider: FoodProvider;
  readonly sourceId: string;
}

export type FoodPreparation = "raw" | "cooked" | "as-sold" | "prepared" | "unknown";

export interface Food {
  readonly id: FoodId;
  /** Catalog release is provenance. A new release does not change the food's ID. */
  readonly release: string | null;
  readonly name: string;
  readonly preparation: FoodPreparation;
  readonly nutrition: FoodNutrition;
}

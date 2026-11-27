export interface Nutrients {
  readonly kcal: number | null;
  readonly proteinG: number | null;
  readonly availableCarbohydratesG: number | null;
  readonly fatG: number | null;
  /** Null denotes an unreported value, including when a provider omits fiber. */
  readonly fiberG: number | null;
}

export interface MeasuredPortion {
  readonly amount: number;
  readonly unit: "g" | "ml";
}

export type Portion = MeasuredPortion | { readonly amount: number; readonly unit: "portion" };
export type NutritionBasis = "per-100-g" | "per-100-ml" | "per-portion";

export interface FoodNutrition {
  readonly basis: NutritionBasis;
  readonly nutrients: Nutrients;
  /** The measured size of one portion, if the source supplies it. */
  readonly portionSize?: MeasuredPortion;
  readonly gramsPerMilliliter?: number;
}

const bases: Record<NutritionBasis, Portion> = {
  "per-100-g": { amount: 100, unit: "g" },
  "per-100-ml": { amount: 100, unit: "ml" },
  "per-portion": { amount: 1, unit: "portion" },
};

const nutrientNames = ["kcal", "proteinG", "availableCarbohydratesG", "fatG", "fiberG"] as const;
type NutrientName = (typeof nutrientNames)[number];

function checkedAmount(amount: number, label: string): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return amount;
}

function checkedNutrient(value: number, name: NutrientName): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative, or null when missing`);
  }
  return value;
}

function mapNutrients(
  nutrients: Nutrients,
  map: (value: number, name: NutrientName) => number,
): Nutrients {
  const mapValue = (name: NutrientName) => {
    const value = nutrients[name];
    return value === null ? null : map(checkedNutrient(value, name), name);
  };
  return {
    kcal: mapValue("kcal"),
    proteinG: mapValue("proteinG"),
    availableCarbohydratesG: mapValue("availableCarbohydratesG"),
    fatG: mapValue("fatG"),
    fiberG: mapValue("fiberG"),
  };
}

function amountInUnit(
  measure: MeasuredPortion,
  unit: MeasuredPortion["unit"],
  density: number | undefined,
): number {
  if (measure.unit === unit) return measure.amount;
  if (density === undefined) {
    throw new RangeError("Converting between grams and milliliters requires a known density");
  }
  return unit === "g" ? measure.amount * density : measure.amount / density;
}

function requirePortionSize(size: MeasuredPortion | undefined): MeasuredPortion {
  if (size === undefined) throw new RangeError("A portion needs a known measured size");
  return size;
}

function portionScale(food: FoodNutrition, portion: Portion): number {
  if (!Object.hasOwn(bases, food.basis)) throw new RangeError("Unknown nutrition basis");
  const basis = bases[food.basis];
  const { portionSize, gramsPerMilliliter: density } = food;
  checkedAmount(portion.amount, "Portion amount");
  if (portion.unit !== "g" && portion.unit !== "ml" && portion.unit !== "portion") {
    throw new RangeError("Unknown portion unit");
  }
  if (portionSize !== undefined) {
    checkedAmount(portionSize.amount, "Measured portion size");
    if (portionSize.unit !== "g" && portionSize.unit !== "ml") {
      throw new RangeError("A measured portion must use grams or milliliters");
    }
  }
  if (density !== undefined) checkedAmount(density, "Density");

  if (portion.unit === basis.unit) return portion.amount / basis.amount;
  const basisMeasurement = basis.unit === "portion" ? requirePortionSize(portionSize) : basis;
  if (portion.unit === "portion") {
    const size = requirePortionSize(portionSize);
    return (
      (amountInUnit(size, basisMeasurement.unit, density) / basisMeasurement.amount) *
      portion.amount
    );
  }
  return amountInUnit(portion, basisMeasurement.unit, density) / basisMeasurement.amount;
}

/** Scale the food's nutrition to the chosen portion without rounding. */
export function nutritionForPortion(food: FoodNutrition, portion: Portion): Nutrients {
  const scale = checkedAmount(portionScale(food, portion), "Portion scale");
  return mapNutrients(food.nutrients, (value, name) => checkedNutrient(value * scale, name));
}

/** A total is unknown if any of its contributing amounts is unknown. */
export function sumNutrition(values: readonly Nutrients[]): Nutrients {
  const totals: { -readonly [Name in NutrientName]: Nutrients[Name] } = {
    kcal: 0,
    proteinG: 0,
    availableCarbohydratesG: 0,
    fatG: 0,
    fiberG: 0,
  };
  for (const nutrients of values) {
    for (const name of nutrientNames) {
      const value = nutrients[name];
      const total = totals[name];
      if (value !== null) checkedNutrient(value, name);
      totals[name] = value === null || total === null ? null : total + value;
    }
  }
  return mapNutrients(totals, (value) => value);
}

/** Round whole kcal and tenths of a gram after scaling or summing. */
export function roundNutritionForDisplay(nutrients: Nutrients): Nutrients {
  return mapNutrients(nutrients, (value, name) => {
    const places = name === "kcal" ? 1 : 10;
    const scaled = value * places;
    if (scaled >= Number.MAX_SAFE_INTEGER) return value;
    if (Number.isInteger(scaled)) return scaled / places;

    // Match a half step lost to floating-point error when scaling or summing portions.
    const midpoint = Math.floor(scaled) + 0.5;
    const atMidpoint = midpoint > scaled && midpoint - scaled <= scaled * Number.EPSILON;
    return Math.round(atMidpoint ? midpoint : scaled) / places;
  });
}

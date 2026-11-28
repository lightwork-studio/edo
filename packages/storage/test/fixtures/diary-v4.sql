-- Synthetic fixture emitted by the v4 diary at b2e94883e428028d14a31d3861e4b051a035a8cb.
PRAGMA application_id = 1162104644;
PRAGMA user_version = 4;
BEGIN;
CREATE TABLE diary_meals (
    id TEXT PRIMARY KEY NOT NULL,
    local_day TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  , utc_offset_minutes INTEGER
        CHECK (utc_offset_minutes IS NULL OR
          (typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -1439 AND 1439)));
CREATE TABLE diary_items (
    id TEXT PRIMARY KEY NOT NULL,
    meal_id TEXT NOT NULL REFERENCES diary_meals(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    UNIQUE (meal_id, position)
  );
CREATE TABLE diary_weigh_ins (
        id TEXT PRIMARY KEY NOT NULL,
        local_day TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        kg REAL NOT NULL CHECK (kg > 0)
      ) STRICT;
CREATE TABLE diary_targets (
        save_order INTEGER PRIMARY KEY CHECK (save_order > 0),
        id TEXT UNIQUE NOT NULL,
        effective_day TEXT NOT NULL,
        configured_at INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'calculated')),
        kcal REAL NOT NULL CHECK (kcal > 0),
        protein_g REAL NOT NULL CHECK (protein_g >= 0),
        fat_g REAL NOT NULL CHECK (fat_g >= 0),
        carbohydrate_g REAL NOT NULL CHECK (carbohydrate_g >= 0)
      ) STRICT;
CREATE TABLE diary_custom_foods (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
CREATE TABLE diary_recipes (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
CREATE TABLE diary_meal_templates (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
CREATE TABLE diary_favorites (
        provider TEXT NOT NULL CHECK (provider IN ('bls', 'open-food-facts', 'usda', 'local')),
        source_id TEXT NOT NULL,
        PRIMARY KEY (provider, source_id)
      ) WITHOUT ROWID, STRICT;
CREATE INDEX diary_meals_by_day ON diary_meals (local_day, occurred_at, id);
CREATE INDEX diary_weigh_ins_by_day ON diary_weigh_ins (local_day, occurred_at, id);
CREATE INDEX diary_targets_by_day ON diary_targets (effective_day, save_order);
INSERT INTO diary_meals VALUES ('meal-1', '2026-10-31', 1793500200000, -240);
INSERT INTO diary_items VALUES ('item-1', 'meal-1', 0, '{"portion":{"amount":50,"unit":"ml"},"food":{"id":{"provider":"open-food-facts","sourceId":"00012345"},"name":"Soy drink","release":"catalog-1","preparation":"as-sold","nutrition":{"basis":"per-100-ml","nutrients":{"kcal":80,"proteinG":7,"availableCarbohydratesG":0,"fatG":3,"fiberG":null}}},"nutrients":{"kcal":40,"proteinG":3.5,"availableCarbohydratesG":0,"fatG":1.5,"fiberG":null}}');
INSERT INTO diary_weigh_ins VALUES ('weight-1', '2026-10-31', 1793500200000, 82.3);
INSERT INTO diary_targets VALUES (1, 'target-1', '2026-10-31', 1793500200000, 'manual', 2000, 100, 80, 220);
INSERT INTO diary_custom_foods VALUES ('homemade-soy', '{"id":{"provider":"local","sourceId":"homemade-soy"},"name":"Homemade soy drink","release":null,"preparation":"as-sold","nutrition":{"basis":"per-100-ml","nutrients":{"kcal":80,"proteinG":7,"availableCarbohydratesG":0,"fatG":3,"fiberG":null}}}');
INSERT INTO diary_recipes VALUES ('recipe-1', '{"id":"recipe-1","name":"Synthetic soy recipe","ingredients":[{"id":"ingredient-1","portion":{"amount":240,"unit":"ml"},"food":{"id":{"provider":"local","sourceId":"homemade-soy"},"name":"Homemade soy drink","release":null,"preparation":"as-sold","nutrition":{"basis":"per-100-ml","nutrients":{"kcal":80,"proteinG":7,"availableCarbohydratesG":0,"fatG":3,"fiberG":null}}},"nutrients":{"kcal":192,"proteinG":16.8,"availableCarbohydratesG":0,"fatG":7.199999999999999,"fiberG":null}}],"servings":2}');
INSERT INTO diary_meal_templates VALUES ('template-1', '{"id":"template-1","name":"Saved late snack","items":[{"id":"item-1","portion":{"amount":50,"unit":"ml"},"food":{"id":{"provider":"open-food-facts","sourceId":"00012345"},"name":"Soy drink","release":"catalog-1","preparation":"as-sold","nutrition":{"basis":"per-100-ml","nutrients":{"kcal":80,"proteinG":7,"availableCarbohydratesG":0,"fatG":3,"fiberG":null}}},"nutrients":{"kcal":40,"proteinG":3.5,"availableCarbohydratesG":0,"fatG":1.5,"fiberG":null}}]}');
INSERT INTO diary_favorites VALUES ('local', 'homemade-soy');
INSERT INTO diary_favorites VALUES ('open-food-facts', '00012345');
COMMIT;

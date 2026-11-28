# USDA import previews

## Foundation Foods

Download the October 2026 **Foundation Foods JSON** ZIP from
[USDA FoodData Central](https://fdc.nal.usda.gov/download-datasets/). The preview
checks the exact archive SHA-256 and emits deterministic JSON in FDC ID order.

```sh
pnpm --silent --filter @edo/usda-import preview /path/to/foundation.zip > foundation-preview.json
```

The preview retains USDA record identifiers, source dates, nutrient IDs, and measurement
metadata. Energy uses the specific Atwater value when available, followed by general
Atwater and the legacy kcal value. Missing or unquantified values remain null.
Carbohydrate by difference includes fiber, so it is recorded separately from available
carbohydrate. The latter is left null for the fallback review. A negative calculated
residual is kept in the source measurements and mapped to null.

## SR Legacy

Download the April 2018 **SR Legacy CSV** ZIP from
[USDA FoodData Central](https://fdc.nal.usda.gov/download-datasets/).

```sh
pnpm --silent --filter @edo/usda-import preview:legacy /path/to/sr-legacy.zip > sr-legacy-preview.json
```

The preview retains the FDC ID, original NDB number and source publication date. It
joins nutrient units and derivation codes from the release's supporting tables.
The shared nutrient mapping keeps available carbohydrate unset in both previews.

German regional equivalents and app selection remain open. USDA publishes the data
under [CC0 1.0](https://fdc.nal.usda.gov/api-guide/). See the
[USDA data documentation](https://fdc.nal.usda.gov/data-documentation/) for the
datasets' definitions.

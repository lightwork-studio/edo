# USDA Foundation Foods import preview

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

The preview covers Foundation Foods. SR Legacy, German regional equivalents and app
selection remain separate work. USDA publishes the data under
[CC0 1.0](https://fdc.nal.usda.gov/api-guide/). Nutrient definitions come from the
[Foundation Foods documentation](https://fdc.nal.usda.gov/Foundation_Foods_Documentation/).

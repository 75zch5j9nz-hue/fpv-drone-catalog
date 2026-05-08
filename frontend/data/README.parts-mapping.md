# Drone Parts Mapping Seed

This directory contains implementation-ready mapping data between manufacturer drone models and their parts.

## Files

- `drone-parts-mapping.seed.json`: generated seed data with indexes for UI filtering.
- `parts-mapping.ts`: typed helper API for importing and searching presets.

## Data source

The seed is generated from `DRONE_TEMPLATES` in `frontend/app/page.tsx`.

## Regenerate

From repository root:

```bash
node scripts/build_drone_parts_seed.mjs
```

## Suggested usage in UI

1. Use `getPartsSeed().brands` for brand filter chips.
2. Use `listPresetsByBrand(brand)` to show model cards per manufacturer.
3. On model selection, use `getPresetByKey(templateKey)?.parts` and convert each item to wizard `pendingComponents`.
4. Use `searchParts(query, { brand, role })` for quick search/autocomplete.

## Notes

- `source_quality: direct` means value was present in template fields.
- `source_quality: inferred-from-notes` is currently used for GPS when the template notes mention GPS.
- Quantities default to `4` for motors and props, `1` for other roles.

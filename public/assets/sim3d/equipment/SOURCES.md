# Equipment asset sources

This collection contains 12 project-authored procedural equipment models for the Corner Shop game. Geometry is implemented in `src/sim3d/equipment-library/`; signage, self-checkout screens and receipts are drawn from original project-authored canvas artwork. No downloaded vendor furniture models, manufacturer logos, product photography or third-party equipment textures are used.

The models use the project's existing Babylon.js geometry helpers and procedural PBR materials. The glass, metal, wood-coloured panels and screen surfaces are material treatments, not scanned real-world finishes. The small English labels and Corner Shop branding are original sample artwork, not functioning payment software.

Each `<id>.glb` is exported from its native equipment factory, with textures embedded. Each `<id>.png` is a screenshot of the corresponding rendered model, not a generated concept illustration. `catalog.json` is generated from the same typed catalogue as the viewer.

The collection is art-only. Stated capacities count standard placement envelopes; they are not refrigeration litres, load ratings, inventory limits or checkout throughput. Glass lids, cabinet doors, keys, screens and scanners are static model details. Existing game furniture and economic rules remain separate.

Regeneration and coordinate contracts are documented in `docs/EQUIPMENT_LIBRARY.md`. Export QA uses `playwright.equipment.config.ts`, writes to the ignored `tmp/equipment-library-exports/` directory, and keeps previews, helpers, cameras and lights out of the GLB model subtree.

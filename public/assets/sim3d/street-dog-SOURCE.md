# Patch: animated street-neighbour dog

`street-dog-patch.glb` is a converted, self-contained copy of the **Dog** model
from **Animal Pack Vol.2** by Quaternius. It is a real authored and rigged 3D
asset, not a procedural mesh, CSS illustration or AI-generated model.

## Exact source and permission

- Author/uploader: **Quaternius**.
- Source page: [Animated Animales Low Poly on OpenGameArt](https://opengameart.org/content/animated-animales-low-poly).
- Original archive: [Animal Pack Vol.2 by @Quaternius.zip](https://opengameart.org/sites/default/files/Animal%20Pack%20Vol.2%20by%20%40Quaternius.zip).
- Author's current dog listing: [Dog on Poly Pizza](https://poly.pizza/m/2kUk0QqpCg).
- License: [Creative Commons Zero 1.0 Universal (CC0-1.0)](https://creativecommons.org/publicdomain/zero/1.0/).
- Acquired and license checked: 2026-09-01.
- Original ZIP SHA-256: `6d8f6789d65dbdb352ebad98a4209f26b41b384e87d81bc05e9ca76139db1248`.
- Extracted `FBX/Dog.fbx` SHA-256: `a7250b3c68857120e6da0fd9ea2cdb4a4493823b6afed371b7aa9208407af039`.

The OpenGameArt page names Quaternius as the author, describes the pack as an
animated dog/cat/wolf/eagle/piranha set and marks it CC0. The Poly Pizza page
independently names Quaternius and marks the Dog model Public Domain (CC0).
CC0 permits use, modification and redistribution without attribution; credit is
kept here voluntarily and to make the shipped asset auditable.

## Runtime preparation

The original FBX was converted with the official Meta/Facebook
[FBX2glTF 0.9.7](https://github.com/facebookincubator/FBX2glTF/releases/tag/v0.9.7)
binary already used by this project's customer pipeline. Conversion uses baked
30 fps animation and computes only missing normals. `scripts/prepare-street-dog.mjs`
then performs two documented, data-only adjustments:

1. renames `DogArmature|Idle` and `DogArmature|Walking` to the runtime contract
   names `idle` and `walk`;
2. changes the legacy Phong conversion's metallic factor from `0.4` to `0` and
   roughness to `0.86`, so the dog reads as fur rather than metal.

No vertices, skin weights, poses or animation samples are authored by the
application. The resulting GLB contains one mesh, one 24-joint skin, one
material and the two original 1.667-second animation clips. Buffers and vertex
colour/material data are embedded; there are no runtime texture or network
requests.

| Runtime file | Bytes | SHA-256 |
| --- | ---: | --- |
| `street-dog-patch.glb` | 125,684 | `07ecec966b657ad945d91af942023f8d665e1149b5e8d215089ccf24f293e6fb` |

The application scales the imported visual to a 0.52 m standing height and
plays only the calm `idle` loop in the street-neighbour scene. The original
`walk` clip is retained for future non-destructive use. No bark, growl or other
dog audio is included.

## Reproduction

Download the archive above, extract only `FBX/Dog.fbx` into an ignored working
directory, and run:

```sh
node scripts/prepare-street-dog.mjs --source /path/to/Dog.fbx
node scripts/prepare-street-dog.mjs --verify-only
npm test -- tests/unit/sim3d-street-neighbour-assets.test.ts
```

The preparation script rejects any source whose hash differs from the reviewed
FBX and refuses a model without its mesh, skin, embedded buffer, exact animation
names or size budget. Automated geometry checks do not replace a visual review
of pose, facing, scale and animation in the Babylon.js scene.

A Babylon.js 9.23 `NullEngine` smoke check also imported the shipped data as two
mesh nodes (one 1,206-vertex render mesh), one skeleton and the exact `idle` and
`walk` animation groups, then started both groups successfully. This proves the
runtime loader contract, not visible colour, facing, grounding or animation
quality; those still require the browser review above.

# Adult customer models

`customer.glb` is a converted and optimized Microsoft Rocketbox `Female_Adult_01`
avatar. The model, original textures, and two animations come from the official
[Microsoft-Rocketbox repository](https://github.com/microsoft/Microsoft-Rocketbox)
at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`.

The roster now also contains three independently modelled avatars from that
same pinned source. These use their original meshes, faces, clothes and hair;
they are not recolours of the first customer. All four share the license below.

| Runtime file | Source avatar | Source texture prefix | Bind-pose height |
| --- | --- | --- | --- |
| `customer.glb` | `Female_Adult_01` | `f001` | 1.74335 m |
| `customer-female-02.glb` | `Female_Adult_02` | `f002` | 1.73516 m |
| `customer-male-01.glb` | `Male_Adult_01` | `m002` | 1.82368 m |
| `customer-male-02.glb` | `Male_Adult_02` | `m003` | 1.82275 m |

The male texture numbering deliberately follows the upstream filenames, which
are one ahead of the avatar number. The added woman has a ponytail, a light
knitted top and a denim skirt; the first man has a striped polo and shorts; the
second man has a V-neck jumper and dark trousers. These descriptions were
checked against the original avatar preview images.

## License and original files

Copyright (c) 2020 Microsoft. Released under the MIT License. Keep the complete
notice in [customer-LICENSE.txt](./customer-LICENSE.txt) with redistributed copies.
The original notice is the pinned
[LICENSE.md](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/LICENSE.md).

- [Female_Adult_01.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx)
- [f_idle_breathe_01.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_static/f_idle_breathe_01.max.fbx)
- [f_walk_neutral.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_xy/f_walk_neutral.max.fbx)
- [Female_Adult_02.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Female_Adult_02/Export/Female_Adult_02.fbx)
- [Male_Adult_01.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Male_Adult_01/Export/Male_Adult_01.fbx)
- [Male_Adult_02.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Male_Adult_02/Export/Male_Adult_02.fbx)
- [m_idle_breathe_01.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_static/m_idle_breathe_01.max.fbx)
- [m_walk_neutral.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_xy/m_walk_neutral.max.fbx)

Only the avatar's three color textures are included. The preparation script
retrieves their immutable Git blobs and verifies the Git SHA-1 of the decoded
bytes before use:

| Texture | Git blob SHA-1 |
| --- | --- |
| `f001_body_color.tga` | `25852db0db1f44a0de0643ce1e09c88aef587e6f` |
| `f001_head_color.tga` | `0cdc62ab47da3dca01aff0bb179159865a559c63` |
| `f001_opacity_color.tga` | `de21a9e69c88e539da6a5050eaceadd026e99b62` |
| `f002_body_color.tga` | `5eb8ee83281a7526544a80ddf9804507670eb049` |
| `f002_head_color.tga` | `8f59bb553f24d3581de68bcf4683695c014bcc0f` |
| `f002_opacity_color.tga` | `3d930c42ed476ab3f58548e5ee33e10ea9f02a27` |
| `m002_body_color.tga` | `818ec72b6c69655c5853ab0eb1efdd6ab40b2bf0` |
| `m002_head_color.tga` | `0becf592ac705b4a2be8a63aa164266ac2a09d9c` |
| `m002_opacity_color.tga` | `a4088df07a8896761bd209d304b12310f90e5003` |
| `m003_body_color.tga` | `23e54f1b4e06ca411aa166a016d77f7536316151` |
| `m003_head_color.tga` | `ec68799915ff8aa26cd18a85c09b1e86c51b17a4` |
| `m003_opacity_color.tga` | `8860d347a396261f06cbb2f620a28efffe11c334` |

## Conversion and runtime contract

- Converted using the official Facebook/Meta
  [FBX2glTF 0.9.7](https://github.com/facebookincubator/FBX2glTF/releases/tag/v0.9.7)
  executable, with animation sampling at 30 fps.
- Repacked by `scripts/prepare-customer.mjs`; textures resized with Pillow by
  `scripts/prepare-customer.py`. No additional app dependencies are needed.
- Body and head color textures are 1024-pixel JPEGs; hair/opacity is a
  1024-pixel RGBA PNG. Normal/specular maps are omitted. Materials use metallic
  factor 0 and roughness 0.88. Hair uses double-sided alpha masking at 0.42.
- glTF 2.0, Y-up, meter-scale units. Original adult proportions are preserved;
  each measured bind-pose height is listed above. Runtime scaling is owned by
  the application, not baked into the asset.
- In Babylon.js 9.23's **default left-handed scene**, the imported avatar faces
  **+Z** when its application-owned parent has `rotation.y = 0`. Babylon's
  glTF-loader coordinate-conversion root must be preserved. This was checked
  visually from both sides. Do not add an extra 180-degree turn on import.
- Each avatar has one skinned mesh, three material primitives, 80 skin joints,
  and 84 glTF nodes. The original woman has 5,438 vertices; the new woman has
  5,600, the first man 4,697, and the second man 4,444. All texture and buffer
  data are embedded in the GLB. No Draco,
  KTX2, external decoder, or network texture request is required at runtime.
- Animation groups are named exactly `idle` and `walk`. Both women use the
  original female clips: 2.666667 seconds / 25 channels and 1.233333 seconds /
  51 channels. Both men use the male clips: 2.733333 seconds / 58 channels and
  1.066667 seconds / 56 channels. Loop playback and playback rate are the
  caller's choice.
- Horizontal X/Z root translation is fixed for both animations; vertical
  breathing/walking movement is retained. The application moves and turns the
  parent object. Other bone translations/scales are not retargeted from the
  motion files, preserving the avatar's original bone lengths.
- The supplied clips have relaxed hands and normal arm swing, **not an authored
  basket-grip pose**. `Bip01 R Hand` and `Bip01 L Hand` bones are available for
  attachments, but a convincing held basket needs pose/offset adjustment in the
  application or a separate carrying animation. Facial speech is not provided.

## Reproduction

Prerequisites: Node.js 22+, Python with Pillow, and FBX2glTF 0.9.7. The automated
converter download uses the official `fbx2gltf@0.9.7` npm tarball, verifies its
SHA-512 integrity, and extracts only the macOS executable into the local
temporary working directory. On Apple Silicon it uses an already-installed
Rosetta runtime; it does not install system software. For other platforms,
set `CUSTOMER_FBX2GLTF` to the corresponding official executable.

```sh
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs --download
node scripts/prepare-customer.mjs --verify-only
```

The default remains `female-01` and preserves the legacy output filename.
Build or verify an individual added avatar with `--avatar`; it never overwrites
another customer's GLB:

```sh
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs --avatar female-02 --download
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs --avatar male-01 --download
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs --avatar male-02 --download
node scripts/prepare-customer.mjs --avatar female-02 --verify-only
node scripts/prepare-customer.mjs --avatar male-01 --verify-only
node scripts/prepare-customer.mjs --avatar male-02 --verify-only
```

With cached sources/conversions:

```sh
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs
node scripts/prepare-customer.mjs --skip-convert
```

`--skip-convert` can also be combined with `--avatar`. Converted model/animation
caches and reports are separated per avatar. Source FBXs, animations and texture
blobs are checked against pinned Git SHA-1s. The compressed Git blob API is used
for downloads, with a 10-second connection timeout and 45-second transfer limit
per file. New responses are written to `.part` files before replacing download
caches; incomplete or wrong-hash caches are never accepted just because they
exist. Run `--download` again to recover an interrupted fetch.

Network access may require an explicit approval in a sandbox. The original
FBX/TGA files, downloaded build tool, intermediate GLBs, and build report stay
under `tmp/customer-source/`; they are not runtime assets and should not be
published with the app. The output is checked against an 8 MiB size budget.

## Verification of the original build

Built and checked on 2026-08-30. `node --check` passed for the preparation script.
The offline verification checks embedded buffers/images, buffer-view bounds,
finite float data, strictly increasing key times, matching key counts, required
clip names, and invariant horizontal root translation. These targeted checks
are not a claim of a full Khronos glTF Validator run.

Babylon.js 9.23 successfully loaded and rendered the GLB; both animations were
played and the model was inspected from front and back. Browser testing was
limited to this model; overall application-flow testing is separate.

- File size: **1,690,988 bytes** (about 1.61 MiB).
- SHA-256: `e94ab0d2e95f42e1bf7bc3697e05cb26c96b6a225b1abfe63d2489024724ef53`.

## Verification of the added avatars

Built on 2026-08-31 using the same conversion/material pipeline. The original
`customer.glb` is byte-for-byte unchanged. Each added avatar passes the offline
checks above. `tests/unit/sim3d-customers.test.ts` also covers all four models'
provenance, bounded embedded data, finite geometry, metre-scale height,
head/hand bones, normalized animated rotations, preserved bone translations,
horizontal root-motion removal, and different mesh/face/outfit data. Visual
WebGL checks and application-flow tests remain separate from those contracts.
In the separate browser preview, all four GLBs were successfully loaded and
their different faces/outfits were inspected; `Male_Adult_02` walking was also
played and visually checked. These checks do not substitute for the full
checkout/day-transition flow tests.

| Added GLB | Bytes | SHA-256 |
| --- | --- | --- |
| `customer-female-02.glb` | 1,832,688 | `8631b35a82aaaba7a1217090b9cf74d5d0da62eec12d5d7590ed71eec06fc849` |
| `customer-male-01.glb` | 1,923,872 | `c36e4b12e9766322b3cd5689d567f37970cb226710f63794e55ce32d99d44d51` |
| `customer-male-02.glb` | 1,695,344 | `44e3a72eaa46239d48c520f8c435528600838db6d0c1cdead7db154383dc5759` |

The four runtime GLBs total 7,142,892 bytes (about 6.81 MiB); the model-contract
test enforces an 8 MiB combined budget as well as distinct meshes and textures.

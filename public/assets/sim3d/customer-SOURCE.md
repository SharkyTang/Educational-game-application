# Adult customer model

`customer.glb` is a converted and optimized Microsoft Rocketbox `Female_Adult_01`
avatar. The model, original textures, and two animations come from the official
[Microsoft-Rocketbox repository](https://github.com/microsoft/Microsoft-Rocketbox)
at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`.

## License and original files

Copyright (c) 2020 Microsoft. Released under the MIT License. Keep the complete
notice in [customer-LICENSE.txt](./customer-LICENSE.txt) with redistributed copies.
The original notice is the pinned
[LICENSE.md](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/LICENSE.md).

- [Female_Adult_01.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx)
- [f_idle_breathe_01.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_static/f_idle_breathe_01.max.fbx)
- [f_walk_neutral.max.fbx](https://github.com/microsoft/Microsoft-Rocketbox/blob/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations/all_animations_max_motextr_xy/f_walk_neutral.max.fbx)

Only the avatar's three color textures are included. The preparation script
retrieves their immutable Git blobs and verifies the Git SHA-1 of the decoded
bytes before use:

| Texture | Git blob SHA-1 |
| --- | --- |
| `f001_body_color.tga` | `25852db0db1f44a0de0643ce1e09c88aef587e6f` |
| `f001_head_color.tga` | `0cdc62ab47da3dca01aff0bb179159865a559c63` |
| `f001_opacity_color.tga` | `de21a9e69c88e539da6a5050eaceadd026e99b62` |

## Conversion and runtime contract

- Converted using the official Facebook/Meta
  [FBX2glTF 0.9.7](https://github.com/facebookincubator/FBX2glTF/releases/tag/v0.9.7)
  executable, with animation sampling at 30 fps.
- Repacked by `scripts/prepare-customer.mjs`; textures resized with Pillow by
  `scripts/prepare-customer.py`. No additional app dependencies are needed.
- Body and head color textures are 1024-pixel JPEGs; hair/opacity is a
  1024-pixel RGBA PNG. Normal/specular maps are omitted. Materials use metallic
  factor 0 and roughness 0.88. Hair uses double-sided alpha masking at 0.42.
- glTF 2.0, Y-up, meter-scale units. Original adult proportions are preserved:
  measured bind-pose height is approximately 1.743 m.
- In Babylon.js 9.23's **default left-handed scene**, the imported avatar faces
  **+Z** when its application-owned parent has `rotation.y = 0`. Babylon's
  glTF-loader coordinate-conversion root must be preserved. This was checked
  visually from both sides. Do not add an extra 180-degree turn on import.
- One skinned mesh, three material primitives, 5,438 vertices, 80 skin joints,
  84 glTF nodes. All texture and buffer data are embedded in the GLB. No Draco,
  KTX2, external decoder, or network texture request is required at runtime.
- Animation groups are named exactly `idle` (2.666667 seconds, 25 channels) and
  `walk` (1.233333 seconds, 51 channels). Loop playback is the caller's choice.
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

With cached sources/conversions:

```sh
CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs
node scripts/prepare-customer.mjs --skip-convert
```

Network access may require an explicit approval in a sandbox. The original
FBX/TGA files, downloaded build tool, intermediate GLBs, and build report stay
under `tmp/customer-source/`; they are not runtime assets and should not be
published with the app. The output is checked against an 8 MiB size budget.

## Verification of this build

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

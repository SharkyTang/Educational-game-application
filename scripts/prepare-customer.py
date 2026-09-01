"""Resize Rocketbox's diffuse/opacity textures for the browser asset.

Run with the bundled Python runtime (Pillow is required). The source TGAs are
kept intact. Textures with alpha stay PNG; opaque textures become JPEG.
"""

import argparse
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tmp" / "customer-source" / "Textures"
TARGET = ROOT / "tmp" / "customer-source" / "prepared-textures"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--texture-prefix",
        choices=("f001", "f002", "f003", "f004", "m002", "m003", "m004", "m006"),
        default="f001",
    )
    prefix = parser.parse_args().texture_prefix
    TARGET.mkdir(parents=True, exist_ok=True)
    for name in ("body", "head", "opacity"):
        source = SOURCE / f"{prefix}_{name}_color.tga"
        with Image.open(source) as original:
            texture = original.convert("RGBA" if name == "opacity" else "RGB")
            texture.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            if name == "opacity":
                output = TARGET / f"{prefix}_{name}_color.png"
                texture.save(output, format="PNG", optimize=True)
            else:
                output = TARGET / f"{prefix}_{name}_color.jpg"
                texture.save(output, format="JPEG", quality=84, optimize=True)
            print(f"{output.relative_to(ROOT)}: {texture.size}, {output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()

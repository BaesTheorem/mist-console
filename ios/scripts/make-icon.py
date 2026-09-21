#!/usr/bin/env python3
"""Compose the app icon from the Console's own MIST mark.

Two rules, both learned on earlier icons:
  * iOS masks the icon with its own superellipse, so the artwork must be a
    full-bleed opaque square; baked-in corners peek out past the mask.
  * A home-screen icon has no alpha. Paint the background explicitly.

The ground is the Console's surface colour (md-tokens.css --md-sys-color-surface)
so the icon and the app open on the same night blue.

Run from ios/:  python3 scripts/make-icon.py
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / "static" / "mist-logo.png"
TARGET = HERE.parent / "MIST/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png"

SIZE = 1024
BACKGROUND = (0x09, 0x14, 0x20)   # --md-sys-color-surface
COVERAGE = 0.72                    # the mark stays inside the system mask


def main() -> None:
    logo = Image.open(SOURCE).convert("RGBA")
    bbox = logo.getbbox()
    if bbox:
        logo = logo.crop(bbox)
    scale = (SIZE * COVERAGE) / max(logo.width, logo.height)
    target = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))
    logo = logo.resize(target, Image.LANCZOS)
    canvas = Image.new("RGB", (SIZE, SIZE), BACKGROUND)
    canvas.paste(logo, ((SIZE - logo.width) // 2, (SIZE - logo.height) // 2), logo)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(TARGET, "PNG")
    print(f"wrote {TARGET} ({SIZE}x{SIZE}, opaque, mark {target[0]}x{target[1]})")


if __name__ == "__main__":
    main()

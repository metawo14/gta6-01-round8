#!/usr/bin/env python3
"""Check a staged SOLMAR screenshot for the six things the frame must hold.

  python3 verify.py <shot.jpg> [<shot2.jpg> ...]

Each check prints PASS/FAIL with the measured number. Exit code is non-zero if any check fails on
any image, so a whole four-shot sweep is one command.

The six checks:
  1. objective card   - neon pixels in the top-centre band
  2. minimap          - bottom-right region is not black
  3. top-left HUD     - health/cash/stars region has neon or brightness
  4. sky strip        - the top strip is brighter than a dark fill
  5. lower half       - real contrast, not a flat fill
  6. colour richness  - a downscaled copy has thousands of distinct colours
"""

from __future__ import annotations

import sys
from collections import Counter

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("verify.py needs Pillow: python3 -m pip install pillow", file=sys.stderr)
    sys.exit(2)

NEON_MIN = 220           # a neon pixel is bright in at least one channel
SAT_MIN = 60             # ...and clearly saturated


def region(px, box):
    """Slice a list-of-rows pixel buffer to a box in pixel coords."""
    left, top, right, bottom = box
    rows = px[top:bottom]
    return [row[left:right] for row in rows]


def neon_count(rows):
    n = 0
    for row in rows:
        for r, g, b in row:
            if max(r, g, b) >= NEON_MIN:
                # A bright pixel that is not grey: the HUD's teal/amber/cash-green.
                if (max(r, g, b) - min(r, g, b)) >= SAT_MIN:
                    n += 1
    return n


def mean_luma(rows):
    total = 0.0
    count = 0
    for row in rows:
        for r, g, b in row:
            total += 0.2126 * r + 0.7152 * g + 0.0722 * b
            count += 1
    return total / max(1, count)


def luma_std(rows):
    vals = []
    for row in rows:
        for r, g, b in row:
            vals.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
    if not vals:
        return 0.0
    m = sum(vals) / len(vals)
    var = sum((v - m) ** 2 for v in vals) / len(vals)
    return var ** 0.5


def check_image(path: str) -> tuple[bool, list[str]]:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    px = list(img.getdata())
    rows = [px[y * w:(y + 1) * w] for y in range(h)]
    results: list[str] = []
    ok = True

    def report(name: str, passed: bool, detail: str) -> None:
        nonlocal ok
        if not passed:
            ok = False
        results.append(f"  [{'PASS' if passed else 'FAIL'}] {name}: {detail}")

    print(f"{path}  ({w}x{h})")

    # 1. Objective card: neon pixels in the top-centre band.
    band = region(rows, (int(w * 0.30), int(h * 0.01), int(w * 0.70), int(h * 0.11)))
    neon = neon_count(band)
    report("objective card neon", neon >= 120, f"{neon} neon px in top-centre (need >=120)")

    # 2. Minimap: bottom-right region not a black fill.
    size = int(min(w, h) * 0.22)
    mini = region(rows, (w - size - 10, h - size - 10, w - 5, h - 5))
    mm_mean = mean_luma(mini)
    mm_std = luma_std(mini)
    report("minimap not black", mm_mean > 14 and mm_std > 6,
           f"mean luma {mm_mean:.1f}, std {mm_std:.1f} (need mean>14, std>6)")

    # 3. Top-left HUD: neon or brightness in the health/cash/stars corner.
    tl = region(rows, (0, int(h * 0.02), int(w * 0.30), int(h * 0.28)))
    tl_neon = neon_count(tl)
    tl_bright = sum(1 for row in tl for r, g, b in row if r + g + b > 330) / max(1, len(tl) * len(tl[0]))
    report("top-left HUD", tl_neon >= 90 or tl_bright > 0.03,
           f"{tl_neon} neon px, {tl_bright * 100:.1f}% bright (need >=90 neon or >3% bright)")

    # 4. Sky strip: brighter than a dark fill.
    sky = region(rows, (0, 0, w, max(1, int(h * 0.10))))
    sky_mean = mean_luma(sky)
    report("sky strip bright", sky_mean > 55, f"mean luma {sky_mean:.1f} (need >55)")

    # 5. Lower half: real contrast, not a flat fill.
    lower = region(rows, (0, int(h * 0.50), w, h))
    low_std = luma_std(lower)
    report("lower half contrast", low_std > 18, f"luma std {low_std:.1f} (need >18)")

    # 6. Colour richness: thousands of distinct colours in a downscaled copy.
    small = img.resize((160, 100), Image.LANCZOS)
    colours = Counter(small.getdata())
    report("colour richness", len(colours) >= 3000,
           f"{len(colours)} distinct colours in 160x100 (need >=3000)")

    print("\n".join(results))
    print(f"  => {'PASS' if ok else 'FAIL'}")
    return ok, results


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    all_ok = True
    for path in argv[1:]:
        try:
            good, _ = check_image(path)
        except FileNotFoundError:
            print(f"{path}: missing", file=sys.stderr)
            good = False
        all_ok = all_ok and good
        print()
    total = (len(argv) - 1) * 6
    print(f"{total} checks across {len(argv) - 1} image(s): {'ALL PASS' if all_ok else 'FAILURES'}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

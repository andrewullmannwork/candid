#!/usr/bin/env python3
"""
Ing-G.2a — SCANNED-tail simulation (closes caveat 2: 0 image-only reals in cold-start).

Real cold-start SBCs are all born-digital (text layer present). Real-world uploads include
print-then-scan SBCs (image-only, no text layer, raster DPI) — the legit-but-degraded tail
that drives G.3 false-positive risk. We simulate it by rasterizing real SBCs: pdftoppm renders
each page to a 150-DPI image, Pillow reassembles an image-only PDF (no text layer).

Labeled stratum='real' (these are LEGITIMATE SBCs, just degraded) with provenance so G.3 FP can
be measured on them. NOTE: simulated rasterization, not true scanner artifacts (no skew/noise);
producer is PIL (a sim tell) — but the load-bearing property (no text layer + raster) is real.

Run: python3 scripts/calibration/adversarial/gen-scanned-sim.py [N]
"""
import os, sys, glob, json, tempfile, subprocess
from PIL import Image

DIR = os.path.join(os.getcwd(), "scripts/calibration/adversarial")
REAL = os.path.join(DIR, "_real_pdfs")


def load_selection():
    p = os.path.join(REAL, "_selection.json")
    m = {}
    if os.path.exists(p):
        for c in json.load(open(p)):
            m[c["seed_id"]] = c
    return m


def rasterize(src, out_pdf, dpi=150):
    with tempfile.TemporaryDirectory() as td:
        pref = os.path.join(td, "p")
        subprocess.run(["pdftoppm", "-png", "-r", str(dpi), src, pref], check=True, timeout=120)
        pngs = sorted(glob.glob(pref + "*.png"))
        if not pngs:
            return False
        imgs = [Image.open(p).convert("RGB") for p in pngs]
        imgs[0].save(out_pdf, save_all=True, append_images=imgs[1:], resolution=float(dpi))
        return True


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    sel = load_selection()
    # source reals = the genuine downloaded set (exclude any prior scan-/modreal artifacts)
    reals = sorted(p for p in glob.glob(os.path.join(REAL, "*.pdf")) if not os.path.basename(p).startswith("scan-"))
    made = 0
    for i, src in enumerate(reals[:n]):
        stem = os.path.basename(src)[:-4]
        out = os.path.join(REAL, f"scan-{i:02d}-{stem}.pdf")
        try:
            if not rasterize(src, out):
                continue
        except Exception as e:
            print(f"  ✗ {stem}: {e}")
            continue
        meta = {"stratum": "real", "provenance": "rasterized-scan-sim", "source_real_pdf": os.path.basename(src)}
        s = sel.get(stem, {})
        for k in ("insurer", "state", "year", "plan_type"):
            if k in s:
                meta[k] = s[k]
        json.dump(meta, open(out.replace(".pdf", ".meta.json"), "w"), indent=2)
        made += 1
        print(f"  ✓ scan-{i:02d}-{stem}.pdf")
    print(f"\nscanned-sim: made {made} image-only reals (rasterized @150dpi) in _real_pdfs/")


if __name__ == "__main__":
    main()

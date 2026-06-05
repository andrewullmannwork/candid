#!/usr/bin/env python3
"""
Ing-G.2a — MODIFIED-REAL stratum (G.2b blind-spot measurement).

Takes real cold-start SBC PDFs and tampers a visible cost-share value, producing two
sub-variants that probe how much the detector leans on the Producer string alone:

  - resaved : pypdf re-save + a tampered "$0" FreeText overlay. Producer becomes pypdf →
              DETECTABLE via a producer allowlist (caught for the re-save signature, not the edit).
  - spoofed : same edit, but Producer is reset to the ORIGINAL insurer producer string →
              the TRUE blind spot: only font-subset / object-structure / raster features can catch it.

Real artifact (fonts, page structure, raster) is preserved from the source; only a value +
the producer metadata change. Writes a .meta.json sidecar per output.

PII: reads LOCAL real PDFs only (already downloaded, gitignored); outputs stay local. Prints
aggregate only.

Run: python3 scripts/calibration/adversarial/gen-modified-real.py [N_per_variant]
"""
import json, sys, glob, os
from pypdf import PdfReader, PdfWriter

DIR = os.path.join(os.getcwd(), "scripts/calibration/adversarial")
REAL = os.path.join(DIR, "_real_pdfs")
OUT = os.path.join(DIR, "_modified_real")
os.makedirs(OUT, exist_ok=True)

try:
    from pypdf.annotations import FreeText
    HAVE_FREETEXT = True
except Exception:
    HAVE_FREETEXT = False


def tamper(src_path, out_name, spoof_producer):
    reader = PdfReader(src_path)
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            return None
    orig_producer = None
    try:
        orig_producer = (reader.metadata or {}).get("/Producer")
    except Exception:
        pass
    writer = PdfWriter()
    writer.append(reader)
    # tamper a visible value on page 1 (simulate an adversary lowering the deductible to $0)
    if HAVE_FREETEXT:
        try:
            ann = FreeText(text="Deductible: $0   Out-of-Pocket Max: $0",
                           rect=(40, 720, 360, 744), font_size="12pt",
                           font_color="000000", background_color="ffffff", border_color="ffffff")
            writer.add_annotation(page_number=0, annotation=ann)
        except Exception:
            pass
    # producer handling: spoofed → claim the original insurer producer; resaved → leave pypdf default
    if spoof_producer and orig_producer:
        writer.add_metadata({"/Producer": orig_producer})
    out_path = os.path.join(OUT, out_name + ".pdf")
    with open(out_path, "wb") as f:
        writer.write(f)
    meta = {
        "stratum": "modified_real",
        "variant": "spoofed" if spoof_producer else "resaved",
        "edit": "freetext_value_overlay" if HAVE_FREETEXT else "resave_only",
        "producer_expected": (orig_producer if spoof_producer else "pypdf"),
        "source_real_pdf": os.path.basename(src_path),
    }
    with open(os.path.join(OUT, out_name + ".meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta["producer_expected"]


def main():
    n_per = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    reals = sorted(glob.glob(os.path.join(REAL, "*.pdf")))
    if len(reals) < n_per * 2:
        print(f"only {len(reals)} real PDFs; need {n_per*2}")
    made = 0
    for i in range(min(n_per, len(reals))):
        if tamper(reals[i], f"modreal-resaved-{i:02d}", spoof_producer=False):
            made += 1
    for i in range(n_per, min(n_per * 2, len(reals))):
        if tamper(reals[i], f"modreal-spoofed-{i:02d}", spoof_producer=True):
            made += 1
    print(f"modified-real: made {made} (resaved + producer-spoofed); FreeText overlay={'on' if HAVE_FREETEXT else 'OFF (resave-only)'}")


if __name__ == "__main__":
    main()

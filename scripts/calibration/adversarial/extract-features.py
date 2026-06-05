#!/usr/bin/env python3
"""
Ing-G.2a — deterministic artifact-feature extractor + corpus manifest builder.

Walks every PDF in the corpus (real / synthetic / modified_real), extracts deterministic
artifact + structural features via poppler (pdfinfo, pdffonts, pdftotext, pdfimages), runs the
SBC structural confirm, and emits:

  - manifest.json        : per-PDF labels + features. COMMITTABLE (no raw content, no user data;
                           real filenames are STATE-insurer-docid8 dataset ids, not PII).
  - corpus-summary.json  : aggregates incl. the producer-overlap analysis (the key G.2a finding:
                           real vs synthetic share producers → producer alone is not separable).

These feature vectors (not raw PDFs) are the G.2b training/validation input + the CI fixture.

Run: python3 scripts/calibration/adversarial/extract-features.py
"""
import json, os, re, glob, subprocess
from collections import Counter, defaultdict

DIR = os.path.join(os.getcwd(), "scripts/calibration/adversarial")
STRATA = {"real": "_real_pdfs", "synthetic": "_synthetic_pdfs", "modified_real": "_modified_real"}
SBC_RE = re.compile(r"summary of benefits and coverage", re.I)
OMB_RE = re.compile(r"0938-?\s?(\d{3,4})")
COLTRIPLET_RE = re.compile(r"why this matters", re.I)
QUESTIONS_RE = re.compile(r"important questions?", re.I)
EXAMPLES_RE = re.compile(r"coverage examples?", re.I)


def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ""


def pdfinfo(p):
    out = run(["pdfinfo", p])
    d = {}
    for line in out.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            d[k.strip().lower()] = v.strip()
    return d


def font_stats(p):
    out = run(["pdffonts", p])
    rows = [r for r in out.splitlines()[2:] if r.strip()]
    emb = sum(1 for r in rows if re.search(r"\byes\b", r.split()[3] if len(r.split()) > 3 else ""))
    # columns: name type encoding emb sub uni object ID ; emb col index ~ -5 robustly
    n_emb = n_sub = 0
    types = Counter()
    for r in rows:
        cols = r.split()
        if len(cols) >= 5:
            types[cols[-7] if len(cols) >= 7 else "?"] += 1
        if " yes " in (" " + r + " "):
            pass
    # robust emb/sub via fixed-width parse
    for r in rows:
        # emb/sub/uni are 3 yes/no columns before the object id pair
        m = re.findall(r"\b(yes|no)\b", r)
        if len(m) >= 3:
            if m[-3] == "yes":
                n_emb += 1
            if m[-2] == "yes":
                n_sub += 1
    return {"n_fonts": len(rows), "n_embedded": n_emb, "n_subset": n_sub}


def image_count(p):
    out = run(["pdfimages", "-list", p])
    rows = [r for r in out.splitlines()[2:] if r.strip()]
    return len(rows)


def text_of(p):
    return run(["pdftotext", "-q", p, "-"]) or ""


def producer_family(prod):
    """Normalize a producer string to a tool family so real-vs-synthetic overlap is measured
    by toolchain, not exact version string (PyPDF2 == pypdf; Skia/PDF m148 == Skia/...Google Docs)."""
    if not prod:
        return "(none)"
    p = prod.lower()
    for fam in ("pypdf", "skia", "pdf-lib", "ghostscript", "itext", "aspose", "abcpdf",
                "pdflib", "xpression", "quadient", "exstream", "fja"):
        if fam in p:
            return fam
    if "adobe" in p and "acrobat" in p:
        return "adobe acrobat"
    if "adobe" in p:
        return "adobe pdf library"
    if "microsoft" in p or "word" in p:
        return "microsoft word"
    return re.sub(r"[\d.][\d.\s]*", "", p).strip().split("(")[0].strip()[:24] or "(other)"


def load_sidecar(p):
    s = p.replace(".pdf", ".meta.json")
    if os.path.exists(s):
        with open(s) as f:
            return json.load(f)
    return {}


def load_real_selection():
    sel = os.path.join(DIR, "_real_pdfs", "_selection.json")
    m = {}
    if os.path.exists(sel):
        with open(sel) as f:
            for c in json.load(f):
                m[c["seed_id"]] = {"insurer": c.get("insurer"), "state": c.get("state"), "year": c.get("year"), "plan_type": c.get("plan_type")}
    return m


def main():
    real_meta = load_real_selection()
    manifest = []
    for stratum, sub in STRATA.items():
        for p in sorted(glob.glob(os.path.join(DIR, sub, "*.pdf"))):
            stem = os.path.basename(p)[:-4]
            info = pdfinfo(p)
            fonts = font_stats(p)
            text = text_of(p)
            tl = len(text.strip())
            nimg = image_count(p)
            omb = OMB_RE.search(text)
            entry = {
                "id": stem,
                "stratum": stratum,
                "producer": info.get("producer", ""),
                "creator": info.get("creator", ""),
                "pages": int(info.get("pages", "0") or 0),
                "file_size": int(re.sub(r"\D", "", info.get("file size", "0")) or 0),
                "encrypted": info.get("encrypted", "no").startswith("yes"),
                **fonts,
                "n_images": nimg,
                "text_len": tl,
                "has_text_layer": tl > 200,
                "image_only_scanned": tl < 200 and nimg > 0,
                # structural (G.3) signals
                "sbc_header": bool(SBC_RE.search(text)),
                "has_why_this_matters": bool(COLTRIPLET_RE.search(text)),
                "has_important_questions": bool(QUESTIONS_RE.search(text)),
                "has_coverage_examples": bool(EXAMPLES_RE.search(text)),
                "omb_present": bool(omb),
                "omb_value": ("0938-" + omb.group(1)) if omb else None,
                "omb_correct": bool(omb and omb.group(1) == "1146"),
            }
            sc = load_sidecar(p)
            for k in ("axis_a_content", "axis_b_renderer", "fidelity", "variant", "omb", "source_html", "source_real_pdf", "producer_expected", "provenance"):
                if k in sc:
                    entry[k] = sc[k]
            if stratum == "real":
                rm = real_meta.get(stem) or sc  # _selection entry, else sidecar (scanned-sim)
                entry.update({"insurer": rm.get("insurer"), "state": rm.get("state"), "year": rm.get("year"), "plan_type": rm.get("plan_type")})
                entry["provenance"] = sc.get("provenance", "born_digital")
            manifest.append(entry)

    with open(os.path.join(DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    # ---- aggregates + the producer-overlap finding ----
    by_stratum = Counter(e["stratum"] for e in manifest)
    prod_by_stratum = defaultdict(Counter)
    for e in manifest:
        prod_by_stratum[e["stratum"]][e["producer"] or "(none)"] += 1
    real_prods = set(prod_by_stratum["real"])
    synth_prods = set(prod_by_stratum["synthetic"])
    overlap = sorted(real_prods & synth_prods)
    # family-level overlap (the real finding): real + synthetic + modified_real share toolchains
    fam_by_stratum = defaultdict(Counter)
    for e in manifest:
        fam_by_stratum[e["stratum"]][producer_family(e["producer"])] += 1
    real_fams = set(fam_by_stratum["real"])
    synth_fams = set(fam_by_stratum["synthetic"])
    modr_fams = set(fam_by_stratum["modified_real"])
    fam_overlap = sorted((synth_fams | modr_fams) & real_fams)
    sbc_confirm = {s: sum(1 for e in manifest if e["stratum"] == s and e["sbc_header"]) for s in STRATA}
    summary = {
        "counts": dict(by_stratum),
        "total": len(manifest),
        "sbc_header_confirmed": sbc_confirm,
        "producers_real": prod_by_stratum["real"].most_common(),
        "producers_synthetic": prod_by_stratum["synthetic"].most_common(),
        "producers_modified_real": prod_by_stratum["modified_real"].most_common(),
        "PRODUCER_OVERLAP_real_vs_synthetic_exact": overlap,
        "producer_families_real": fam_by_stratum["real"].most_common(),
        "producer_families_synthetic": fam_by_stratum["synthetic"].most_common(),
        "producer_families_modified_real": fam_by_stratum["modified_real"].most_common(),
        "PRODUCER_FAMILY_OVERLAP": fam_overlap,
        "real_docs_sharing_synth_or_modr_producer_family": sum(
            fam_by_stratum["real"][f] for f in fam_overlap),
        "finding_producer_not_separable": len(fam_overlap) > 0,
        "scanned_image_only_real": sum(1 for e in manifest if e["stratum"] == "real" and e["image_only_scanned"]),
        "real_provenance": Counter(e.get("provenance", "born_digital") for e in manifest if e["stratum"] == "real").most_common(),
        "real_years": Counter(str(e.get("year")) for e in manifest if e["stratum"] == "real").most_common(),
        "synthetic_renderers": Counter(e.get("axis_b_renderer") for e in manifest if e["stratum"] == "synthetic").most_common(),
        "omb_correct_synthetic": sum(1 for e in manifest if e["stratum"] == "synthetic" and e.get("omb_correct")),
        "structural_complete_real": sum(1 for e in manifest if e["stratum"] == "real" and e["has_why_this_matters"] and e["has_important_questions"]),
    }
    with open(os.path.join(DIR, "corpus-summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    print(f"manifest: {len(manifest)} PDFs  ->  {dict(by_stratum)}")
    print(f"SBC-header confirmed: {sbc_confirm}")
    print(f"PRODUCER OVERLAP exact (real ∩ synthetic): {overlap or 'none'}")
    print(f"PRODUCER FAMILY OVERLAP (real ∩ synthetic∪modified): {fam_overlap}")
    print(f"  -> {summary['real_docs_sharing_synth_or_modr_producer_family']}/{by_stratum['real']} REAL docs share a producer family with an adversarial doc")
    print(f"scanned/image-only reals: {summary['scanned_image_only_real']}  | synthetic w/ correct OMB: {summary['omb_correct_synthetic']}")
    print("wrote manifest.json + corpus-summary.json")


if __name__ == "__main__":
    main()

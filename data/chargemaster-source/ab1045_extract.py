import openpyxl, re, json
path = "/Users/andrewullmann/Downloads/ChargemasterCDM-2025/WOODLAND MEMORIAL HOSPITAL/HCAI_106571086_CDM_ALL.xlsx"
wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
ws = wb["AB 1045 Form"]
rows = []
section = None
for r in ws.iter_rows(values_only=True):
    c0 = "" if r[0] is None else str(r[0]).strip()
    c1 = r[1] if len(r) > 1 else None
    c2 = r[2] if len(r) > 2 else None
    c1s = "" if c1 is None else str(c1).strip()
    # section header row: col1 literally "2025 CPT Code"
    if c1s == "2025 CPT Code":
        section = c0  # the section label sits in col0 of the header row
        continue
    # data row: col1 is a 5-digit CPT
    if re.fullmatch(r"\d{5}", c1s):
        charge = None
        if c2 is not None and str(c2).strip() != "":
            try:
                charge = float(c2)
            except ValueError:
                charge = None
        rows.append({"desc": c0, "cpt": c1s, "charge": charge, "section": section})
priced = [x for x in rows if x["charge"] is not None]
blank = [x for x in rows if x["charge"] is None]
print(f"TOTAL CPT rows: {len(rows)} | PRICED: {len(priced)} | BLANK-charge: {len(blank)}")
print("\n=== PRICED ROWS (seed candidates) ===")
for x in priced:
    print(f"  {x['cpt']}  ${x['charge']:>9.2f}  {x['desc'][:46]:<46}  [{x['section']}]")
print("\n=== BLANK-charge CPTs (skipped) ===")
for x in blank:
    print(f"  {x['cpt']}  {x['desc'][:46]}")

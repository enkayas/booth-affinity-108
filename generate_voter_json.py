#!/usr/bin/env python3
"""
generate_voter_json.py
======================
Regenerates voter_data/{booth}.json from the latest eroll + religion + BJP membership.

Row format (matches VL_COLS in app.js):
  [sl, epic, name, relation, house, age, gender, deleted, phone, bjp, religion]
   0    1     2      3        4     5    6        7        8      9    10
"""

import re, glob, json, math
import pandas as pd
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────
EROLL_DIR  = Path("/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/02_data_mgmt/2026/Input_Files/01-eroll-latest/108-eroll-xls-final-20260416")
REL_FILE   = Path("/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/02_data_mgmt/2026/Input_Files/01-eroll-latest/Consolidated Voters/AC108_Consolidated_Voters_WithReligion Update.xlsx")
OUT_DIR    = Path("/Users/nk/Documents/GitHub/booth-affinity-108/BOOTH_AFFINITY/voter_data")
MANDAL_MAP = Path("/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/Code/BJP_pdf_extracts/input/108_booth_mandal_mapping.xlsx")
BJP_FILE   = Path("/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/02_data_mgmt/2026/Input_Files/01-eroll-latest/Consolidated Voters/AC108_Consolidated_Voters_WithReligion Update.xlsx")

def booth_from_filename(path):
    m = re.search(r'-ENG-(\d+)-WI\.xlsx$', str(path), re.IGNORECASE)
    return int(m.group(1)) if m else None

def safe_phone(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    try:
        return str(int(float(v)))
    except:
        return str(v).strip() or None

# ── Load religion lookup (EPIC → religion) ────────────────────────────────────
print("Loading religion + BJP membership file …")
rel_df = pd.read_excel(REL_FILE, dtype={'EPIC No': str})
epic_religion = dict(zip(rel_df['EPIC No'].str.strip(), rel_df['Predicted Religion']))
print(f"  {len(epic_religion):,} EPIC → religion entries")

# ── Load BJP membership lookup (EPIC → bool) ─────────────────────────────────
# BJP membership already in rel_df
epic_bjp = {
    str(r['EPIC No']).strip(): 1
    for _, r in rel_df.iterrows()
    if str(r.get('BJP Member', '')).strip().lower() == 'yes'
}
print(f"  {len(epic_bjp):,} BJP members")

# ── Load booth → mandal mapping ───────────────────────────────────────────────
mandal_df = pd.read_excel(MANDAL_MAP)
b_col = next(c for c in mandal_df.columns if 'booth' in c.lower())
m_col = next(c for c in mandal_df.columns if 'mandal' in c.lower())
mandal_lookup = dict(zip(mandal_df[b_col].astype(int), mandal_df[m_col].str.strip()))
print(f"  {len(mandal_lookup)} booth→mandal mappings")

# ── Process each booth ────────────────────────────────────────────────────────
print("\nGenerating voter JSON files …")
eroll_files = sorted(glob.glob(str(EROLL_DIR / '*.xlsx')))
total_written = 0

for fpath in eroll_files:
    booth_no = booth_from_filename(fpath)
    if not booth_no:
        print(f"  SKIP: {fpath}")
        continue

    df = pd.read_excel(fpath, dtype={'EPIC': str})

    rows = []
    for _, r in df.iterrows():
        epic    = str(r.get('EPIC', '') or '').strip()
        deleted = 'Y' if str(r.get('Deleted', '')).strip().lower() in ('true','yes','y','1') else 'N'
        phone   = safe_phone(r.get('Phone_Number') or r.get('Phone Number'))
        bjp     = epic_bjp.get(epic, 0)
        religion= epic_religion.get(epic, 'Unknown')

        rows.append([
            r.get('Serial_No'),          # 0  sl
            epic,                         # 1  epic
            str(r.get('Name','') or ''), # 2  name
            str(r.get('Relation_Name','') or ''),  # 3  relation
            str(r.get('House_No','') or ''),        # 4  house
            int(r['Age']) if pd.notna(r.get('Age')) else None,  # 5  age
            str(r.get('Gender','') or ''),           # 6  gender
            deleted,                     # 7  deleted
            phone,                       # 8  phone
            bjp,                         # 9  bjp
            religion,                    # 10 religion
        ])

    out = {
        'booth':  booth_no,
        'mandal': mandal_lookup.get(booth_no, ''),
        'rows':   rows
    }

    out_path = OUT_DIR / f'{booth_no}.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    total_written += 1
    if total_written % 50 == 0:
        print(f"  {total_written}/{len(eroll_files)} done …")

print(f"\nDone — {total_written} booth JSON files written to {OUT_DIR}")

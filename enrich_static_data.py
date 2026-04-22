"""
Merges 108_Booth_LVL_SUMMARY_V6.xlsx into booth_affinity_static_data.json.

New fields added to each booth:
  boothGrade      – full descriptor e.g. "A - Won - Lead 43.4%"
  boothRating     – single letter A-F (overrides existing A/B from Win/Loss col)
  marginVsInc     – 2021 BJP margin vs INC  (+ve = won, -ve = lost), rounded 3dp
  firstTimeVoters – first-time voter count
  boothRankAC     – rank among all 254 booths in AC108
  boothRankMandal – rank within mandal
  tvkImpact       – TVK-risk voter count (0 if null)
  ntkImpact       – NTK-risk voter count (0 if null)
  age2435         – voters aged 24-35
  age3650         – voters aged 36-50
  age5165         – voters aged 51-65
  age6679         – voters aged 66-79
  age80plus       – voters aged 80+
"""

import json, sys, os, openpyxl

V6_PATH    = (
    "/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP"
    "/02_data_mgmt/2026/Output/01_master_data/108_Booth_LVL_SUMMARY_V6.xlsx"
)
STATIC_PATH = os.path.join(os.path.dirname(__file__), "booth_affinity_static_data.json")

# ── Load V6 ──────────────────────────────────────────────────────────────────
wb = openpyxl.load_workbook(V6_PATH, read_only=True, data_only=True)
ws = wb["Master Dashboard 108"]
rows = list(ws.iter_rows(values_only=True))
headers = rows[0]

def col(name):
    return headers.index(name)

v6 = {}
for r in rows[1:]:
    bn = r[col("Booth#")]
    if not isinstance(bn, (int, float)):
        continue
    bn = int(bn)
    grade_str  = str(r[col("Booth_Grade")] or "").strip()
    grade_letter = grade_str[0] if grade_str else ""
    margin = r[col("Margin_vs_INC")]
    v6[bn] = {
        "boothGrade":      grade_str,
        "boothRating":     grade_letter,
        "marginVsInc":     round(float(margin), 4) if margin is not None else None,
        "firstTimeVoters": int(r[col("First Time")] or 0),
        "boothRankAC":     int(r[col("Booth Rank AC108")] or 0),
        "boothRankMandal": int(r[col("Booth Rank (Mandal)")] or 0),
        "tvkImpact":       int(r[col("TVK impact")] or 0),
        "ntkImpact":       int(r[col("NTK Impact")] or 0),
        "age2435":         int(r[col("24-35 Yrs")] or 0),
        "age3650":         int(r[col("36-50Yrs")] or 0),
        "age5165":         int(r[col("51-65Yrs")] or 0),
        "age6679":         int(r[col("66-79Yrs")] or 0),
        "age80plus":       int(r[col(">+80Yrs")] or 0),
    }

print(f"V6: loaded {len(v6)} booths")

# ── Load static data ──────────────────────────────────────────────────────────
with open(STATIC_PATH, encoding="utf-8") as f:
    static = json.load(f)

booths = static["booths"]
matched = 0
missing = []

for b in booths:
    bn = int(b["booth"])
    if bn in v6:
        b.update(v6[bn])
        matched += 1
    else:
        missing.append(bn)

print(f"Matched: {matched}/{len(booths)}")
if missing:
    print(f"No V6 data for booths: {missing}")

# ── Write back ────────────────────────────────────────────────────────────────
with open(STATIC_PATH, "w", encoding="utf-8") as f:
    json.dump(static, f, ensure_ascii=False, separators=(",", ":"))

print(f"Written: {STATIC_PATH}")

# ── Verify spot-check ─────────────────────────────────────────────────────────
sample = next(b for b in booths if b["booth"] == 1)
print("\nBooth 1 spot-check:")
for k in ["boothGrade","boothRating","marginVsInc","boothRankAC","tvkImpact","age2435"]:
    print(f"  {k}: {sample[k]}")

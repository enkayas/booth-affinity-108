import json
from pathlib import Path

import pandas as pd


VOTING_FILE = Path(
    "/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/02_data_mgmt/2026/Output/VOTING DAY/Booth Voting Final with Rating.xlsx"
)
MASTER_FILE = Path(
    "/Users/nk/Library/CloudStorage/OneDrive-Personal/BJP/02_data_mgmt/2026/Output/01_master_data/108_Booth_LVL_SUMMARY_V6.xlsx"
)
OUTPUT_FILE = Path("Voting_Day_2026_Booth_Dashboard.html")


def clean_number(value, default=0):
    if pd.isna(value):
        return default
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def clean_float(value):
    if pd.isna(value):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if value > 1.5:
        value = value / 100
    return value


def clean_poll_percent(value):
    value = clean_float(value)
    if value is None:
        return None
    return value if 0 <= value <= 1 else None


def clean_text(value):
    if pd.isna(value):
        return ""
    return str(value).strip()


def load_data():
    master_xl = pd.ExcelFile(MASTER_FILE)
    voting = pd.read_excel(VOTING_FILE, sheet_name="VOTING PROGRESS", header=1)
    voting = voting[pd.to_numeric(voting["Booth#"], errors="coerce").notna()].copy()
    voting["Booth#"] = voting["Booth#"].astype(int)

    master = pd.read_excel(MASTER_FILE, sheet_name="Master Dashboard 108")
    master = master[pd.to_numeric(master["Booth#"], errors="coerce").notna()].copy()
    master["Booth#"] = master["Booth#"].astype(int)

    if "2021 & 2024 Results" in master_xl.sheet_names:
        results_2021 = pd.read_excel(MASTER_FILE, sheet_name="2021 & 2024 Results", header=1)
        results_2024 = results_2021.copy()
    else:
        results_2021 = pd.read_excel(MASTER_FILE, sheet_name="2021 results", header=1)
        results_2024 = pd.read_excel(MASTER_FILE, sheet_name="2024 Results", header=1)

    results_2021 = results_2021[pd.to_numeric(results_2021["Booth NO"], errors="coerce").notna()].copy()
    results_2021["Booth NO"] = results_2021["Booth NO"].astype(int)
    results_2024 = results_2024[pd.to_numeric(results_2024["Booth NO"], errors="coerce").notna()].copy()
    results_2024["Booth NO"] = results_2024["Booth NO"].astype(int)

    results_2016 = pd.read_excel(MASTER_FILE, sheet_name="2016 Results")
    results_2016 = results_2016[pd.to_numeric(results_2016["Booth#"], errors="coerce").notna()].copy()
    results_2016["Booth#"] = results_2016["Booth#"].astype(int)

    results_2011 = pd.read_excel(MASTER_FILE, sheet_name="2011 Results")
    results_2011 = results_2011[pd.to_numeric(results_2011["Booth#"], errors="coerce").notna()].copy()
    results_2011["Booth#"] = results_2011["Booth#"].astype(int)

    results_2006 = pd.read_excel(MASTER_FILE, sheet_name="2006 Results")
    results_2006 = results_2006[pd.to_numeric(results_2006["Booth#"], errors="coerce").notna()].copy()
    results_2006["Booth#"] = results_2006["Booth#"].astype(int)

    master_map = master.set_index("Booth#").to_dict("index")
    r2021_map = results_2021.set_index("Booth NO").to_dict("index")
    r2024_map = results_2024.set_index("Booth NO").to_dict("index")
    r2016_map = results_2016.set_index("Booth#").to_dict("index")
    r2011_map = results_2011.set_index("Booth#").to_dict("index")
    r2006_map = results_2006.set_index("Booth#").to_dict("index")

    booths = []
    for row in voting.to_dict("records"):
        booth = clean_number(row.get("Booth#"))
        m = master_map.get(booth, {})
        y21 = r2021_map.get(booth, {})
        y24 = r2024_map.get(booth, {})
        y16 = r2016_map.get(booth, {})
        y11 = r2011_map.get(booth, {})
        y06 = r2006_map.get(booth, {})

        total = clean_number(row.get("Total") or m.get("Total"))
        polled_2026 = clean_number(row.get("VOTES POLLED"))
        poll_2026 = clean_poll_percent(row.get("POLLING %"))
        if poll_2026 is None and total:
            poll_2026 = polled_2026 / total

        votes_2016 = clean_number(y16.get("Total Votes"), None)
        votes_2011 = clean_number(y11.get("Total Votes"), None)
        pct_2016 = (votes_2016 / total) if votes_2016 is not None and total else None
        pct_2011 = (votes_2011 / total) if votes_2011 is not None and total else None

        booth_grade = clean_text(row.get("BOOTH GRADE") or m.get("Booth_Grade"))
        focus_category = clean_text(row.get("FOCUS CATEGORY"))
        explicit_focus = clean_text(row.get("FOCUS BOOTH")).upper() == "YES"
        derived_focus = bool(booth_grade) and booth_grade.upper() != "NON-FOCUS"

        booths.append(
            {
                "booth": booth,
                "town": clean_text(row.get("Town/Village") or m.get("Town/Village")),
                "pollingStation": clean_text(row.get("Polling Station") or m.get("Polling Station")),
                "mandal": clean_text(row.get("Mandal") or m.get("Mandal")),
                "male": clean_number(row.get("Male") or m.get("Male")),
                "female": clean_number(row.get("Female") or m.get("Female")),
                "thirdGender": clean_number(row.get("3rd Gen") or m.get("3rd Gen")),
                "total": total,
                "votes2026": polled_2026,
                "poll2026": poll_2026,
                "pollingGrade": clean_text(row.get("Overall Classification") or row.get("Booth Category") or row.get("POLLING GRADE")),
                "focusBooth": explicit_focus or derived_focus,
                "boothGrade": booth_grade,
                "focusCategory": focus_category,
                "highMinority": clean_text(row.get("HIGH MINORITY")).upper() == "YES",
                "minorityPct": clean_float(row.get("MINORITY %")),
                "finalized": clean_text(row.get("Finalized")),
                "poll2024": clean_poll_percent(y24.get("2024_POLL%")),
                "votes2024": clean_number(y24.get("2024_TOTAL"), None),
                "poll2021": clean_poll_percent(row.get("2021 POLL %") if not pd.isna(row.get("2021 POLL %", None)) else (m.get("2021 POLL%") if not pd.isna(m.get("2021 POLL%", None)) else y21.get("2021_Polling %"))),
                "votes2021": clean_number(y21.get("2021_Votes_polled"), None),
                "poll2016": pct_2016,
                "votes2016": votes_2016,
                "poll2011": pct_2011,
                "votes2011": votes_2011,
                "poll2006": clean_float(y06.get("Turnout %")),
                "votes2006": clean_number(y06.get("Voters Polled"), None),
                "bjp2021": clean_float(row.get("2021 BJP %") if not pd.isna(row.get("2021 BJP %", None)) else m.get("2021_BJP%")),
                "inc2021": clean_float(row.get("2021 INC %") if not pd.isna(row.get("2021 INC %", None)) else m.get("2021_INC%")),
                "marginVsInc": clean_float(row.get("2021 MARGIN vs INC %") if not pd.isna(row.get("2021 MARGIN vs INC %", None)) else m.get("Margin_vs_INC")),
                "rankAc": clean_number(m.get("Booth Rank AC108"), None),
                "rankMandal": clean_number(m.get("Booth Rank (Mandal)"), None),
                "hindu": clean_number(m.get("Hindu"), None),
                "christian": clean_number(m.get("Christian"), None),
                "muslim": clean_number(m.get("Muslim"), None),
                "others": clean_number(m.get("Others"), None),
            }
        )

    totals = {
        "totalBooths": len(booths),
        "totalElectors": sum(b["total"] for b in booths),
        "votes2026": sum(b["votes2026"] for b in booths),
        "updatedBooths": sum(1 for b in booths if b["votes2026"] > 0 or b["finalized"].lower() == "yes"),
    }
    totals["poll2026"] = totals["votes2026"] / totals["totalElectors"] if totals["totalElectors"] else None

    payload = {
        "generatedAt": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sourceFiles": [str(VOTING_FILE), str(MASTER_FILE)],
        "totals": totals,
        "booths": booths,
    }
    return payload


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>2026 Voting Booth Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js"></script>
  <style>
    :root {
      --bg: #f5f7fb;
      --surface: #ffffff;
      --surface-2: #eef2f7;
      --text: #172033;
      --muted: #667085;
      --border: #dbe3ee;
      --accent: #f97316;
      --accent-dark: #dd6412;
      --green: #15803d;
      --red: #c62828;
      --amber: #b45309;
      --blue: #2563eb;
      --shadow: 0 18px 42px -34px rgba(15, 23, 42, 0.72);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #fbfcff 0%, var(--bg) 100%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Tamil", "Noto Sans", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }

    button, input, select {
      font: inherit;
    }

    .login-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
    }

    .login-card {
      width: min(420px, 100%);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .login-head {
      padding: 22px;
      background: linear-gradient(135deg, #ff8c2f 0%, #f97316 62%, #d95c0b 100%);
      color: white;
    }

    .login-head h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
    }

    .login-head p {
      margin: 8px 0 0;
      opacity: 0.92;
    }

    .login-body {
      padding: 22px;
    }

    label {
      display: block;
      margin: 14px 0 6px;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    input, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: white;
      color: var(--text);
      padding: 11px 12px;
    }

    input:focus, select:focus {
      outline: none;
      border-color: rgba(249, 115, 22, 0.8);
      box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.14);
    }

    .primary-btn, .ghost-btn {
      border: 0;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 800;
      padding: 11px 14px;
    }

    .primary-btn {
      width: 100%;
      margin-top: 16px;
      background: var(--accent);
      color: white;
    }

    .ghost-btn {
      background: var(--surface-2);
      color: var(--text);
    }

    .login-error {
      min-height: 18px;
      margin-top: 10px;
      color: var(--red);
      font-size: 13px;
      font-weight: 700;
    }

    .language-toggle {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .language-toggle span {
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
    }

    .radio-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 7px 10px;
      background: white;
      color: var(--text);
      font-weight: 800;
      cursor: pointer;
    }

    .radio-pill input {
      width: auto;
      margin: 0;
      accent-color: var(--accent);
    }

    .app {
      display: none;
      min-height: 100vh;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(255,255,255,0.94);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
    }

    .topbar-inner {
      max-width: 1380px;
      margin: 0 auto;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
    }

    .brand h2 {
      margin: 0;
      font-size: 20px;
      color: var(--accent-dark);
    }

    .brand p {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .brand .sub-heading {
      color: var(--green);
      font-weight: 900;
    }

    .brand .generated-line {
      font-size: 11px;
    }

    .top-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .wrap {
      max-width: 1380px;
      margin: 0 auto;
      padding: 16px;
    }

    .filters {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
      align-items: end;
    }

    .search-box {
      grid-column: span 2;
    }

    .kpis {
      display: grid;
      grid-template-columns: repeat(6, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .kpi-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .kpi-value {
      margin-top: 6px;
      font-size: 28px;
      line-height: 1;
      font-weight: 900;
    }

    .kpi-sub {
      margin-top: 7px;
      color: var(--muted);
      font-size: 12px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 14px;
      margin-bottom: 14px;
    }

    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 12px;
    }

    .section-title h3 {
      margin: 0;
      font-size: 16px;
    }

    .section-title p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }

    .bars {
      display: grid;
      gap: 9px;
    }

    .bar-row {
      display: grid;
      grid-template-columns: minmax(90px, 150px) 1fr 112px;
      gap: 10px;
      align-items: center;
    }

    .bar-name {
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bar-track {
      height: 10px;
      background: var(--surface-2);
      border-radius: 999px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 999px;
    }

    .bar-fill.green { background: var(--green); }
    .bar-fill.blue { background: var(--blue); }
    .bar-fill.amber { background: var(--amber); }
    .bar-value {
      text-align: right;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }

    .mini-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }

    .mini-stat {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: #fbfcff;
    }

    .mini-stat strong {
      display: block;
      font-size: 24px;
      line-height: 1;
    }

    .mini-stat span {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .table-card {
      padding: 0;
      overflow: hidden;
    }

    .table-head {
      padding: 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .table-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .table-wrap {
      overflow: auto;
      max-height: 560px;
    }

    .table-footnote {
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      background: var(--surface-2);
      z-index: 1;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    tbody tr {
      cursor: pointer;
    }

    tbody tr:hover {
      background: #fff7ed;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 900;
      background: #e7edf6;
      color: #344054;
      white-space: nowrap;
    }

    .badge.yes { background: #ffedd5; color: #9a3412; }
    .badge.green { background: #dcfce7; color: #166534; }
    .badge.red { background: #fee2e2; color: #991b1b; }
    .delta-up { color: var(--green); font-weight: 900; }
    .delta-down { color: var(--red); font-weight: 900; }
    .muted { color: var(--muted); }

    .detail-panel {
      display: grid;
      gap: 9px;
    }

    .detail-title {
      font-size: 18px;
      font-weight: 900;
    }

    .detail-row {
      display: grid;
      grid-template-columns: 128px 1fr;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }

    .detail-row span:first-child {
      color: var(--muted);
      font-weight: 800;
    }

    @media (max-width: 1100px) {
      .filters, .kpis { grid-template-columns: repeat(2, 1fr); }
      .search-box { grid-column: span 2; }
      .grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 640px) {
      .wrap, .topbar-inner { padding-left: 10px; padding-right: 10px; }
      .filters, .kpis, .mini-grid { grid-template-columns: 1fr; }
      .search-box { grid-column: span 1; }
      .bar-row { grid-template-columns: 92px 1fr 96px; }
      .kpi-value { font-size: 24px; }
    }

    @page {
      size: A4 landscape;
      margin: 10mm;
    }

    @media print {
      body {
        background: #fff;
      }

      .login-page,
      .topbar,
      .filters,
      .kpis,
      .grid,
      .table-actions {
        display: none !important;
      }

      .wrap {
        max-width: none;
        padding: 0;
      }

      .table-card {
        border: 0;
        box-shadow: none;
      }

      .table-wrap {
        max-height: none;
        overflow: visible;
      }

      table {
        min-width: 0;
        font-size: 8px;
      }

      th,
      td {
        padding: 4px 5px;
      }

      th {
        position: static;
      }
    }
  </style>
</head>
<body>
  <section id="loginPage" class="login-page">
    <div class="login-card">
      <div class="login-head">
        <h1 data-i18n="loginTitle">2026 Uthagamandalam Polling Dashboard</h1>
        <p data-i18n="loginSub">Booth level turnout, historical polling percentage, and focus booth tracking.</p>
      </div>
      <div class="login-body">
        <div class="language-toggle" role="radiogroup" aria-label="Language">
          <span data-i18n="language">Language</span>
          <label class="radio-pill"><input type="radio" name="lang" value="en" checked /> English</label>
          <label class="radio-pill"><input type="radio" name="lang" value="ta" /> தமிழ்</label>
        </div>
        <form id="loginForm">
          <label for="userId" data-i18n="userId">User ID</label>
          <input id="userId" type="tel" inputmode="numeric" maxlength="10" autocomplete="username" data-i18n-placeholder="phonePlaceholder" placeholder="10 digit phone number" />
          <label for="password" data-i18n="password">Password</label>
          <input id="password" type="password" maxlength="10" autocomplete="current-password" data-i18n-placeholder="passwordPlaceholder" placeholder="Same as phone number" />
          <div id="loginError" class="login-error"></div>
          <button class="primary-btn" type="submit" data-i18n="login">Login</button>
        </form>
      </div>
    </div>
  </section>

  <section id="app" class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <h2 data-i18n="appTitle">2026 Uthagamandalam Polling Dashboard</h2>
          <p class="sub-heading" data-i18n="subHeading">BJP Nilgiris. IT & Data Management team</p>
          <p class="generated-line"><span data-i18n="generated">Generated</span>: <span id="generatedAt"></span></p>
        </div>
        <div class="top-actions">
          <div class="language-toggle" role="radiogroup" aria-label="Language">
            <span data-i18n="language">Language</span>
            <label class="radio-pill"><input type="radio" name="langTop" value="en" checked /> English</label>
            <label class="radio-pill"><input type="radio" name="langTop" value="ta" /> தமிழ்</label>
          </div>
          <button id="logoutBtn" class="ghost-btn" type="button" data-i18n="logout">Logout</button>
        </div>
      </div>
    </header>

    <main class="wrap">
      <section class="filters card">
        <div>
          <label for="mandalFilter" data-i18n="mandal">Mandal</label>
          <select id="mandalFilter"></select>
        </div>
        <div>
          <label for="focusFilter" data-i18n="focus">Focus Booth</label>
          <select id="focusFilter">
            <option value="all" data-i18n="all">All</option>
            <option value="yes" data-i18n="yes">Yes</option>
            <option value="no" data-i18n="no">No</option>
          </select>
        </div>
        <div>
          <label for="gradeFilter" data-i18n="pollingGrade">Booth Grade</label>
          <select id="gradeFilter"></select>
        </div>
        <div class="search-box">
          <label for="searchBox" data-i18n="search">Search</label>
          <input id="searchBox" type="search" data-i18n-placeholder="searchPlaceholder" placeholder="Booth, town, station..." />
        </div>
      </section>

      <section class="kpis" id="kpis"></section>

      <section class="grid">
        <div class="card">
          <div class="section-title">
            <h3 data-i18n="mandalPerformance">Mandal Performance</h3>
            <p data-i18n="currentTurnout">2026 turnout</p>
          </div>
          <div id="mandalBars" class="bars"></div>
        </div>
        <div class="card">
          <div class="section-title">
            <h3 data-i18n="historicalComparison">Historical Comparison</h3>
            <p data-i18n="filteredAverage">Filtered average</p>
          </div>
          <div id="historyBars" class="bars"></div>
        </div>
      </section>

      <section class="grid">
        <div class="card">
          <div class="section-title">
            <h3 data-i18n="focusSummary">Focus Category Summary</h3>
            <p data-i18n="focusOnly">Focus booths only</p>
          </div>
          <div id="focusBars" class="bars"></div>
        </div>
        <div class="card">
          <div class="section-title">
            <h3 data-i18n="selectedBooth">Selected Booth</h3>
            <p data-i18n="clickRow">Click a row</p>
          </div>
          <div id="boothDetail" class="detail-panel muted" data-i18n="selectBoothHint">Select a booth from the table to view details.</div>
        </div>
      </section>

      <section class="card table-card">
        <div class="table-head">
          <div>
            <div class="section-title" style="margin:0;">
              <h3 data-i18n="boothTable">Booth Level Table</h3>
              <p id="tableCount"></p>
            </div>
          </div>
          <div class="table-actions">
            <button id="pdfBtn" class="ghost-btn" type="button" data-i18n="downloadPdf">Download PDF</button>
            <button id="resetBtn" class="ghost-btn" type="button" data-i18n="resetFilters">Reset Filters</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="booth">Booth</th>
                <th data-i18n="town">Town</th>
                <th data-i18n="mandal">Mandal</th>
                <th data-i18n="electors">Electors</th>
                <th data-i18n="votes2026">2026 Votes</th>
                <th data-i18n="poll2026">2026 Poll %</th>
                <th data-i18n="poll2024">2024 Poll %</th>
                <th data-i18n="poll2021">2021 Poll %</th>
                <th data-i18n="deltaVs2021">Delta vs 2021</th>
                <th data-i18n="focus">Focus</th>
                <th data-i18n="netVoters">Net Voters</th>
                <th data-i18n="grade">Grade</th>
              </tr>
            </thead>
            <tbody id="boothRows"></tbody>
          </table>
        </div>
        <div id="tableFootnote" class="table-footnote"></div>
      </section>
    </main>
  </section>

  <script>
    const DATA = __DATA__;

    const translations = {
      en: {
        loginTitle: "2026 Uthagamandalam Polling Dashboard",
        loginSub: "Booth level turnout, historical polling percentage, and focus booth tracking.",
        language: "Language",
        userId: "User ID",
        phonePlaceholder: "10 digit phone number",
        password: "Password",
        passwordPlaceholder: "Same as phone number",
        login: "Login",
        loginError: "Enter a 10 digit phone number and use the same number as password.",
        appTitle: "2026 Uthagamandalam Polling Dashboard",
        subHeading: "BJP Nilgiris. IT & Data Management team",
        generated: "Generated",
        logout: "Logout",
        mandal: "Mandal",
        focus: "Focus Booth",
        highMinority: "High Minority",
        pollingGrade: "Booth Grade",
        all: "All",
        yes: "Yes",
        no: "No",
        search: "Search",
        searchPlaceholder: "Booth, town, station...",
        totalElectors: "Total Electors",
        votesPolled: "Votes Polled",
        overallPoll: "Overall Poll %",
        boothsUpdated: "Booths Updated",
        focusBooths: "Focus Booths",
        highMinorityBooths: "High Minority Booths",
        mandalPerformance: "Mandal Performance",
        currentTurnout: "2026 turnout",
        historicalComparison: "Historical Comparison",
        filteredAverage: "Filtered average",
        focusSummary: "Focus Category Summary",
        focusOnly: "Focus booths only",
        selectedBooth: "Selected Booth",
        clickRow: "Click a row",
        selectBoothHint: "Select a booth from the table to view details.",
        boothTable: "Booth Level Table",
        resetFilters: "Reset Filters",
        booth: "Booth",
        town: "Town",
        electors: "Electors",
        votes2026: "2026 Votes",
        poll2026: "2026 Poll %",
        poll2024: "2024 Poll %",
        poll2021: "2021 Poll %",
        deltaVs2021: "Delta vs 2021",
        netVoters: "Net Voters",
        netVotersFull: "Net Voter Change vs 2021",
        comparableBooths: "comparable booths",
        categoryFootnote: "Category footnote",
        category: "Category",
        grade: "Grade",
        downloadPdf: "Download PDF",
        station: "Polling Station",
        maleFemale: "Male / Female",
        boothGrade: "Booth Grade",
        minorityPct: "Minority %",
        rank: "AC Rank",
        records: "records",
        pending: "Pending"
      },
      ta: {
        loginTitle: "2026 உதகமண்டலம் வாக்குப்பதிவு டாஷ்போர்டு",
        loginSub: "பூத் வாரியான வாக்குப்பதிவு, வரலாற்று வாக்குப்பதிவு சதவீதம், முக்கிய பூத் கண்காணிப்பு.",
        language: "மொழி",
        userId: "பயனர் ஐடி",
        phonePlaceholder: "10 இலக்க தொலைபேசி எண்",
        password: "கடவுச்சொல்",
        passwordPlaceholder: "தொலைபேசி எண்ணையே உள்ளிடவும்",
        login: "உள்நுழை",
        loginError: "10 இலக்க தொலைபேசி எண்ணை உள்ளிட்டு அதையே கடவுச்சொல்லாக பயன்படுத்தவும்.",
        appTitle: "2026 உதகமண்டலம் வாக்குப்பதிவு டாஷ்போர்டு",
        subHeading: "பாஜக நீலகிரி. IT & Data Management team",
        generated: "உருவாக்கப்பட்டது",
        logout: "வெளியேறு",
        mandal: "மண்டல்",
        focus: "முக்கிய பூத்",
        highMinority: "அதிக சிறுபான்மை",
        pollingGrade: "பூத் தரம்",
        all: "அனைத்தும்",
        yes: "ஆம்",
        no: "இல்லை",
        search: "தேடல்",
        searchPlaceholder: "பூத், ஊர், வாக்குச்சாவடி...",
        totalElectors: "மொத்த வாக்காளர்கள்",
        votesPolled: "பதிவான வாக்குகள்",
        overallPoll: "மொத்த வாக்குப்பதிவு %",
        boothsUpdated: "புதுப்பிக்கப்பட்ட பூத்துகள்",
        focusBooths: "முக்கிய பூத்துகள்",
        highMinorityBooths: "அதிக சிறுபான்மை பூத்துகள்",
        mandalPerformance: "மண்டல் செயல்திறன்",
        currentTurnout: "2026 வாக்குப்பதிவு",
        historicalComparison: "வரலாற்று ஒப்பீடு",
        filteredAverage: "வடிகட்டிய சராசரி",
        focusSummary: "முக்கிய பிரிவு சுருக்கம்",
        focusOnly: "முக்கிய பூத்துகள் மட்டும்",
        selectedBooth: "தேர்ந்தெடுத்த பூத்",
        clickRow: "வரிசையை சொடுக்கவும்",
        selectBoothHint: "விவரங்களை பார்க்க அட்டவணையில் ஒரு பூத்தை தேர்வு செய்யவும்.",
        boothTable: "பூத் வாரியான அட்டவணை",
        resetFilters: "வடிகட்டிகளை மீட்டமை",
        booth: "பூத்",
        town: "ஊர்",
        electors: "வாக்காளர்கள்",
        votes2026: "2026 வாக்குகள்",
        poll2026: "2026 வாக்கு %",
        poll2024: "2024 வாக்கு %",
        poll2021: "2021 வாக்கு %",
        deltaVs2021: "2021 ஒப்பீடு",
        netVoters: "நிகர வாக்குகள்",
        netVotersFull: "2021 ஒப்பீட்டில் நிகர வாக்கு மாற்றம்",
        comparableBooths: "ஒப்பிடத்தக்க பூத்துகள்",
        categoryFootnote: "பிரிவு குறிப்பு",
        category: "பிரிவு",
        grade: "தரம்",
        downloadPdf: "PDF பதிவிறக்கு",
        station: "வாக்குச்சாவடி",
        maleFemale: "ஆண் / பெண்",
        boothGrade: "பூத் தரம்",
        minorityPct: "சிறுபான்மை %",
        rank: "AC தரவரிசை",
        records: "பதிவுகள்",
        pending: "நிலுவை"
      }
    };

    const state = {
      lang: "en",
      selectedBooth: null
    };

    const els = {};
    [
      "loginPage", "app", "loginForm", "userId", "password", "loginError", "generatedAt",
      "logoutBtn", "mandalFilter", "focusFilter", "gradeFilter",
      "searchBox", "kpis", "mandalBars", "historyBars", "focusBars", "boothRows",
      "tableCount", "tableFootnote", "resetBtn", "pdfBtn", "boothDetail"
    ].forEach(id => els[id] = document.getElementById(id));

    function t(key) {
      return translations[state.lang][key] || translations.en[key] || key;
    }

    function setLanguage(lang) {
      state.lang = lang;
      document.documentElement.lang = lang === "ta" ? "ta" : "en";
      document.querySelectorAll('input[name="lang"], input[name="langTop"]').forEach(input => {
        input.checked = input.value === lang;
      });
      document.querySelectorAll("[data-i18n]").forEach(node => {
        node.textContent = t(node.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach(node => {
        node.placeholder = t(node.dataset.i18nPlaceholder);
      });
      if (els.app && els.app.style.display !== "none") {
        const selectedMandal = els.mandalFilter.value || "all";
        const selectedGrade = els.gradeFilter.value || "all";
        initFilters();
        els.mandalFilter.value = selectedMandal;
        els.gradeFilter.value = selectedGrade;
      }
      render();
      if (state.selectedBooth) renderDetail(state.selectedBooth);
    }

    function pct(value) {
      return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
    }

    function num(value) {
      return Number(value || 0).toLocaleString("en-IN");
    }

    function avgPct(rows, field) {
      const valid = rows.filter(row => row[field] != null && row.total);
      const denom = valid.reduce((sum, row) => sum + row.total, 0);
      if (!denom) return null;
      return valid.reduce((sum, row) => sum + row[field] * row.total, 0) / denom;
    }

    function currentRows() {
      const mandal = els.mandalFilter.value;
      const focus = els.focusFilter.value;
      const grade = els.gradeFilter.value;
      const query = els.searchBox.value.trim().toLowerCase();
      return DATA.booths.filter(row => {
        if (mandal !== "all" && row.mandal !== mandal) return false;
        if (focus !== "all" && row.focusBooth !== (focus === "yes")) return false;
        if (grade !== "all" && row.boothGrade !== grade) return false;
        if (query) {
          const haystack = `${row.booth} ${row.town} ${row.pollingStation} ${row.mandal}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
    }

    function grouped(rows, key) {
      const map = new Map();
      rows.forEach(row => {
        const name = row[key] || "-";
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(row);
      });
      return [...map.entries()];
    }

    function sumRows(rows) {
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      const votes = rows.reduce((sum, row) => sum + row.votes2026, 0);
      return { total, votes, poll: total ? votes / total : null };
    }

    function netVoteChange(rows) {
      const comparable = rows.filter(row => Number.isFinite(Number(row.votes2021)));
      const votes2026 = comparable.reduce((sum, row) => sum + Number(row.votes2026 || 0), 0);
      const votes2021 = comparable.reduce((sum, row) => sum + Number(row.votes2021 || 0), 0);
      return { net: votes2026 - votes2021, votes2026, votes2021, comparable: comparable.length };
    }

    function signedNum(value) {
      if (value == null) return "-";
      const prefix = value > 0 ? "+" : "";
      return `${prefix}${Number(value).toLocaleString("en-IN")}`;
    }

    function renderKpis(rows) {
      const totals = sumRows(rows);
      const focusRows = rows.filter(row => row.focusBooth);
      const minorityRows = rows.filter(row => row.highMinority);
      const updated = rows.filter(row => row.votes2026 > 0 || String(row.finalized).toLowerCase() === "yes").length;
      const net = netVoteChange(rows);
      const kpis = [
        [t("totalElectors"), num(totals.total), `${rows.length} ${t("records")}`],
        [t("votesPolled"), num(totals.votes), ""],
        [t("netVotersFull"), signedNum(net.net), `${net.comparable} ${t("comparableBooths")}`],
        [t("overallPoll"), pct(totals.poll), `${t("poll2024")}: ${pct(avgPct(rows, "poll2024"))}`],
        [t("boothsUpdated"), `${updated}/${rows.length}`, `${rows.length - updated} ${t("pending")}`],
        [t("focusBooths"), String(focusRows.length), pct(sumRows(focusRows).poll)],
        [t("highMinorityBooths"), String(minorityRows.length), pct(sumRows(minorityRows).poll)]
      ];
      els.kpis.innerHTML = kpis.map(([label, value, sub]) => `
        <article class="card">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${value}</div>
          <div class="kpi-sub">${sub || "&nbsp;"}</div>
        </article>
      `).join("");
    }

    function barRows(items, options = {}) {
      const max = options.max || 1;
      if (!items.length) return `<div class="muted">No data</div>`;
      return items.map(item => {
        const width = Math.max(0, Math.min(100, (item.value || 0) / max * 100));
        return `
          <div class="bar-row">
            <div class="bar-name" title="${item.name}">${item.name}</div>
            <div class="bar-track"><div class="bar-fill ${item.color || ""}" style="width:${width}%"></div></div>
            <div class="bar-value">${options.format ? options.format(item) : pct(item.value)}</div>
          </div>
        `;
      }).join("");
    }

    function renderMandalBars(rows) {
      const items = grouped(rows, "mandal")
        .map(([name, group]) => ({ name, value: sumRows(group).poll, net: netVoteChange(group).net }))
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      els.mandalBars.innerHTML = barRows(items, { max: 1, format: item => `${pct(item.value)} | ${signedNum(item.net)}` });
    }

    function renderHistory(rows) {
      const history = [
        ["2026", sumRows(rows).poll, "green"],
        ["2024", avgPct(rows, "poll2024"), "blue"],
        ["2021", avgPct(rows, "poll2021"), "amber"],
      ];
      els.historyBars.innerHTML = barRows(history.map(([name, value, color]) => ({ name, value, color })), { max: 1 });
    }

    function renderFocus(rows) {
      const focusRows = rows.filter(row => row.focusBooth);
      const items = grouped(focusRows, "focusCategory")
        .map(([name, group]) => ({ name: name || "-", value: sumRows(group).poll }))
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      els.focusBars.innerHTML = barRows(items, { max: 1 });
    }

    function deltaClass(value) {
      if (value == null) return "";
      return value >= 0 ? "delta-up" : "delta-down";
    }

    function isAPlusBooth(row) {
      return String(row.pollingGrade || "").trim().toUpperCase() === "A+" || String(row.boothGrade || "").trim().toUpperCase().startsWith("A+");
    }

    function deltaValue(row) {
      if (row.poll2026 == null || row.poll2021 == null) return null;
      const delta = row.poll2026 - row.poll2021;
      return isAPlusBooth(row) && delta < 0 ? 0 : delta;
    }

    function deltaText(value) {
      return value == null ? "-" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
    }

    function renderTable(rows) {
      els.tableCount.textContent = `${rows.length} ${t("records")}`;
      const categories = [...new Set(rows.map(row => row.focusCategory).filter(Boolean))].sort();
      els.tableFootnote.textContent = `${t("categoryFootnote")}: ${categories.length ? categories.join(" | ") : "-"}`;
      els.boothRows.innerHTML = rows
        .slice()
        .sort((a, b) => a.booth - b.booth)
        .map(row => {
          const delta = deltaValue(row);
          const net = Number.isFinite(Number(row.votes2021)) ? Number(row.votes2026 || 0) - Number(row.votes2021 || 0) : null;
          return `
            <tr data-booth="${row.booth}">
              <td><strong>${row.booth}</strong></td>
              <td>${row.town}</td>
              <td>${row.mandal}</td>
              <td>${num(row.total)}</td>
              <td>${num(row.votes2026)}</td>
              <td><span class="badge green">${pct(row.poll2026)}</span></td>
              <td>${pct(row.poll2024)}</td>
              <td>${pct(row.poll2021)}</td>
              <td class="${deltaClass(delta)}">${deltaText(delta)}</td>
              <td>${row.focusBooth ? `<span class="badge yes">${t("yes")}</span>` : `<span class="badge">${t("no")}</span>`}</td>
              <td class="${deltaClass(net)}">${signedNum(net)}</td>
              <td>${row.boothGrade || "-"}</td>
            </tr>
          `;
        })
        .join("");

      els.boothRows.querySelectorAll("tr").forEach(tr => {
        tr.addEventListener("click", () => {
          const booth = Number(tr.dataset.booth);
          state.selectedBooth = DATA.booths.find(row => row.booth === booth);
          renderDetail(state.selectedBooth);
        });
      });
    }

    function renderDetail(row) {
      if (!row) return;
      const delta = deltaValue(row);
      const net = Number.isFinite(Number(row.votes2021)) ? Number(row.votes2026 || 0) - Number(row.votes2021 || 0) : null;
      els.boothDetail.classList.remove("muted");
      els.boothDetail.innerHTML = `
        <div class="detail-title">${t("booth")} ${row.booth} - ${row.town}</div>
        <div class="detail-row"><span>${t("station")}</span><strong>${row.pollingStation}</strong></div>
        <div class="detail-row"><span>${t("mandal")}</span><strong>${row.mandal}</strong></div>
        <div class="detail-row"><span>${t("maleFemale")}</span><strong>${num(row.male)} / ${num(row.female)}</strong></div>
        <div class="detail-row"><span>${t("poll2026")}</span><strong>${pct(row.poll2026)} (${num(row.votes2026)} / ${num(row.total)})</strong></div>
        <div class="detail-row"><span>${t("poll2024")}</span><strong>${pct(row.poll2024)}</strong></div>
        <div class="detail-row"><span>${t("poll2021")}</span><strong>${pct(row.poll2021)}</strong></div>
        <div class="detail-row"><span>${t("deltaVs2021")}</span><strong class="${deltaClass(delta)}">${deltaText(delta)}</strong></div>
        <div class="detail-row"><span>${t("netVoters")}</span><strong class="${deltaClass(net)}">${signedNum(net)}</strong></div>
        <div class="detail-row"><span>${t("focus")}</span><strong>${row.focusBooth ? t("yes") : t("no")} ${row.focusCategory ? `- ${row.focusCategory}` : ""}</strong></div>
        <div class="detail-row"><span>${t("boothGrade")}</span><strong>${row.boothGrade || "-"}</strong></div>
        <div class="detail-row"><span>${t("highMinority")}</span><strong>${row.highMinority ? t("yes") : t("no")} ${row.minorityPct != null ? `(${pct(row.minorityPct)})` : ""}</strong></div>
        <div class="detail-row"><span>${t("rank")}</span><strong>${row.rankAc || "-"}</strong></div>
      `;
    }

    function render() {
      if (!els.app || els.app.style.display === "none") return;
      const rows = currentRows();
      renderKpis(rows);
      renderMandalBars(rows);
      renderHistory(rows);
      renderFocus(rows);
      renderTable(rows);
    }

    function activeFilterText() {
      const parts = [];
      parts.push(`${t("mandal")}: ${els.mandalFilter.value === "all" ? t("all") : els.mandalFilter.value}`);
      parts.push(`${t("focus")}: ${els.focusFilter.options[els.focusFilter.selectedIndex].text}`);
      parts.push(`${t("pollingGrade")}: ${els.gradeFilter.value === "all" ? t("all") : els.gradeFilter.value}`);
      if (els.searchBox.value.trim()) parts.push(`${t("search")}: ${els.searchBox.value.trim()}`);
      return parts.join(" | ");
    }

    function exportPdf() {
      const rows = currentRows().slice().sort((a, b) => a.booth - b.booth);
      const jspdf = window.jspdf;
      if (!jspdf || !jspdf.jsPDF) {
        window.print();
        return;
      }

      const doc = new jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      if (typeof doc.autoTable !== "function") {
        window.print();
        return;
      }

      const totals = sumRows(rows);
      const net = netVoteChange(rows);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text(t("appTitle"), 36, 34);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(`${t("generated")}: ${DATA.generatedAt} | ${activeFilterText()}`, 36, 50, { maxWidth: 770 });
      doc.text(`${t("totalElectors")}: ${num(totals.total)} | ${t("votesPolled")}: ${num(totals.votes)} | ${t("netVotersFull")}: ${signedNum(net.net)} | ${rows.length} ${t("records")}`, 36, 64, { maxWidth: 770 });

      doc.autoTable({
        startY: 78,
        head: [[
          t("booth"), t("town"), t("mandal"), t("station"), t("electors"), t("votes2026"),
          t("poll2026"), t("poll2021"), t("deltaVs2021"), t("focus"), t("netVoters"), t("grade")
        ]],
        body: rows.map(row => {
          const delta = deltaValue(row);
          const rowNet = Number.isFinite(Number(row.votes2021)) ? Number(row.votes2026 || 0) - Number(row.votes2021 || 0) : null;
          return [
            row.booth,
            row.town,
            row.mandal,
            row.pollingStation,
            row.total,
            row.votes2026,
            pct(row.poll2026),
            pct(row.poll2021),
            deltaText(delta),
            row.focusBooth ? t("yes") : t("no"),
            signedNum(rowNet),
            row.boothGrade || "-"
          ];
        }),
        theme: "grid",
        styles: { font: "helvetica", fontSize: 7, cellPadding: 3, overflow: "linebreak" },
        headStyles: { fillColor: [249, 115, 22], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          0: { cellWidth: 34 },
          1: { cellWidth: 70 },
          2: { cellWidth: 62 },
          3: { cellWidth: 168 },
          4: { cellWidth: 44, halign: "right" },
          5: { cellWidth: 44, halign: "right" },
          6: { cellWidth: 48, halign: "right" },
          7: { cellWidth: 48, halign: "right" },
          8: { cellWidth: 52, halign: "right" },
          9: { cellWidth: 38 },
          10: { cellWidth: 56 },
          11: { cellWidth: 78 }
        },
        margin: { left: 36, right: 36 },
        didDrawPage: () => {
          const page = doc.internal.getNumberOfPages();
          doc.setFontSize(8);
          doc.text(`Page ${page}`, doc.internal.pageSize.getWidth() - 64, doc.internal.pageSize.getHeight() - 18);
        }
      });

      const categories = [...new Set(rows.map(row => row.focusCategory).filter(Boolean))].sort();
      const footnoteY = doc.lastAutoTable.finalY + 12;
      if (footnoteY < doc.internal.pageSize.getHeight() - 24) {
        doc.setFontSize(8);
        doc.text(`${t("categoryFootnote")}: ${categories.length ? categories.join(" | ") : "-"}`, 36, footnoteY, { maxWidth: 770 });
      }

      doc.save(`2026_booth_level_table_${new Date().toISOString().slice(0, 10)}.pdf`);
    }

    function initFilters() {
      const mandals = [...new Set(DATA.booths.map(row => row.mandal).filter(Boolean))].sort();
      els.mandalFilter.innerHTML = `<option value="all">${t("all")}</option>` + mandals.map(m => `<option value="${m}">${m}</option>`).join("");

      const grades = [...new Set(DATA.booths.map(row => row.boothGrade).filter(Boolean))].sort();
      els.gradeFilter.innerHTML = `<option value="all">${t("all")}</option>` + grades.map(g => `<option value="${g}">${g}</option>`).join("");
    }

    function showApp() {
      els.loginPage.style.display = "none";
      els.app.style.display = "block";
      els.generatedAt.textContent = DATA.generatedAt;
      initFilters();
      render();
    }

    els.loginForm.addEventListener("submit", event => {
      event.preventDefault();
      const phone = els.userId.value.replace(/\D/g, "");
      const pass = els.password.value.replace(/\D/g, "");
      if (!/^\d{10}$/.test(phone) || pass !== phone) {
        els.loginError.textContent = t("loginError");
        return;
      }
      els.loginError.textContent = "";
      showApp();
    });

    els.logoutBtn.addEventListener("click", () => {
      els.app.style.display = "none";
      els.loginPage.style.display = "grid";
      els.password.value = "";
    });

    document.querySelectorAll('input[name="lang"], input[name="langTop"]').forEach(input => {
      input.addEventListener("change", event => setLanguage(event.target.value));
    });

    [els.mandalFilter, els.focusFilter, els.gradeFilter, els.searchBox].forEach(el => {
      el.addEventListener("input", render);
      el.addEventListener("change", render);
    });

    els.resetBtn.addEventListener("click", () => {
      els.mandalFilter.value = "all";
      els.focusFilter.value = "all";
      els.gradeFilter.value = "all";
      els.searchBox.value = "";
      render();
    });

    els.pdfBtn.addEventListener("click", exportPdf);

    setLanguage("en");
  </script>
</body>
</html>
"""


def main():
    payload = load_data()
    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(payload, ensure_ascii=False, allow_nan=False))
    OUTPUT_FILE.write_text(html, encoding="utf-8")
    print(f"Wrote {OUTPUT_FILE} with {len(payload['booths'])} booth records.")


if __name__ == "__main__":
    main()

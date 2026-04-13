// Backfill_Utility.gs
//
// PURPOSE:
// Recomputes and fixes the Booth Affinity Master summary sheet by reading
// the raw affinity data directly from the affinity sheet and recalculating
// A/B/C/D/E counts and completion percentage for every booth.
//
// WHEN TO USE:
// Run this manually when the dashboard totals look wrong or out of sync,
// for example after a bulk data import, a manual sheet edit, or a failed save.
//
// HOW TO RUN:
// 1. Open the Apps Script editor for this project.
// 2. Select backfillMasterFromAffinitySheet from the function dropdown.
// 3. Click Run.
// 4. Check Execution Log for per-booth results.
//
// SAFE TO RE-RUN:
// This function only writes to the Booth Affinity Master summary sheet.
// It never modifies the raw affinity data rows.

function backfillMasterFromAffinitySheet() {
  // Load all rows from the raw affinity sheet
  var affinitySheet = getAffinitySheet_();
  var values = affinitySheet.getDataRange().getValues();

  // Nothing to process if sheet has only a header row or is empty
  if (!values || values.length < 2) {
    Logger.log('Affinity sheet is empty. Nothing to backfill.');
    return;
  }

  // Normalize header names so column lookups are case/space insensitive
  var headers = values[0].map(function(h) { return normalizeHeader_(h); });

  // Find the column indexes for the fields we need
  var iBooth = findHeaderIndexByNormalized_(headers, ['booth', 'booth no', 'booth number', 'booth#', 'booth no.']);
  var iSlNo = findHeaderIndexByNormalized_(headers, ['slno', 'sl no', 'sl_no', 'serial no', 'serial_no']);
  var iAffinity = findHeaderIndexByNormalized_(headers, ['affinity', 'value']);
  var iRelocated = findHeaderIndexByNormalized_(headers, ['relocated']);
  var iVoted = findHeaderIndexByNormalized_(headers, ['voted']);
  var iUpdatedAt = findHeaderIndexByNormalized_(headers, ['updatedat', 'updated at']);

  // Abort early if any required column is missing
  if (iBooth < 0 || iSlNo < 0 || iAffinity < 0) {
    Logger.log('ERROR: Required columns not found in affinity sheet. Aborting.');
    return;
  }

  // boothMap[boothNo][slNo] = { affinity, relocated, voted, ts }
  // Used to deduplicate: if the same slNo appears more than once for a booth,
  // the row with the latest updatedAt timestamp wins.
  var boothMap = {};

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var boothNo = toNumber_(row[iBooth]);
    if (!boothNo) continue; // skip rows with no booth number

    var slNo = toNumber_(row[iSlNo]);
    if (!slNo) continue; // skip rows with no serial number

    var affinity = String(row[iAffinity] == null ? '' : row[iAffinity]).trim().toUpperCase();
    if (!/^[A-E]$/.test(affinity)) continue; // skip blank or invalid affinity values

    // Use row index as fallback timestamp; prefer actual updatedAt date if available
    var ts = r;
    if (iUpdatedAt >= 0) {
      var d = new Date(row[iUpdatedAt]);
      if (!isNaN(d.getTime())) ts = d.getTime();
    }

    var relocated = false;
    if (iRelocated >= 0) {
      relocated = readBooleanFlag_(row[iRelocated]);
    }

    var voted = false;
    if (iVoted >= 0) {
      voted = readBooleanFlag_(row[iVoted]);
    }

    // Keep only the latest entry for each booth+slNo combination
    if (!boothMap[boothNo]) boothMap[boothNo] = {};
    if (!boothMap[boothNo][slNo] || ts >= boothMap[boothNo][slNo].ts) {
      boothMap[boothNo][slNo] = {
        affinity: affinity,
        relocated: relocated,
        voted: voted,
        ts: ts
      };
    }
  }

  var boothNos = Object.keys(boothMap);
  Logger.log('Booths to backfill: ' + boothNos.length);

  // For each booth, tally A/B/C/D/E counts and write to master summary sheet
  boothNos.forEach(function(b) {
    var boothNo = Number(b);
    var slMap = boothMap[b];

    // Count how many voters have each affinity label
    var summary = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    Object.keys(slMap).forEach(function(sl) {
      var a = slMap[sl].affinity;
      if (summary[a] !== undefined) summary[a]++;
    });

    var relocatedTotal = 0;
    var votedTotal = 0;

    var completed = summary.A + summary.B + summary.C + summary.D + summary.E;
    Object.keys(slMap).forEach(function(sl) {
      if (slMap[sl].relocated) relocatedTotal++;
      if (slMap[sl].voted) votedTotal++;
    });

    // Write recomputed values into the Booth Affinity Master row for this booth
    var completionPct = upsertBoothMasterSummary_(boothNo, summary, completed, relocatedTotal, votedTotal);

    Logger.log(
      'Booth ' + boothNo +
      ': A=' + summary.A +
      ' B=' + summary.B +
      ' C=' + summary.C +
      ' D=' + summary.D +
      ' E=' + summary.E +
      ' relocated=' + relocatedTotal +
      ' voted=' + votedTotal +
      ' completed=' + completed +
      ' pct=' + completionPct + '%'
    );
  });

  Logger.log('Backfill complete for ' + boothNos.length + ' booths.');
}

// deduplicateAffinitySheet
//
// PURPOSE:
// Removes duplicate rows from the raw affinity sheet so that every
// Booth + slNo combination appears exactly once (latest timestamp wins).
//
// WHEN TO USE:
// Run once after deploying the new Api.gs to clean up any duplicates
// that accumulated before the fix. Safe to re-run at any time.
//
// HOW TO RUN:
// 1. Open the Apps Script editor.
// 2. Select deduplicateAffinitySheet from the function dropdown.
// 3. Click Run.
// 4. Check Execution Log for how many duplicates were removed.

function deduplicateAffinitySheet() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getAffinitySheet_();
    var values = sheet.getDataRange().getValues();

    if (!values || values.length < 2) {
      Logger.log('Nothing to deduplicate.');
      return;
    }

    var headers = values[0].map(function(h) { return normalizeHeader_(h); });
    var iBooth = findHeaderIndexByNormalized_(headers, ['booth', 'booth no', 'booth number', 'booth#', 'booth no.']);
    var iSlNo = findHeaderIndexByNormalized_(headers, ['slno', 'sl no', 'sl_no', 'serial no', 'serial_no']);
    var iAffinity = findHeaderIndexByNormalized_(headers, ['affinity', 'value']);
    var iUpdatedAt = findHeaderIndexByNormalized_(headers, ['updatedat', 'updated at']);

    if (iBooth < 0 || iSlNo < 0 || iAffinity < 0) {
      Logger.log('ERROR: Required columns not found. Aborting.');
      return;
    }

    // For each booth+slNo key, track which row index has the latest timestamp
    var seen = {};

    for (var r = 1; r < values.length; r++) {
      var boothNo = toNumber_(values[r][iBooth]);
      var slNo = toNumber_(values[r][iSlNo]);
      if (!boothNo || !slNo) continue;

      var key = boothNo + '_' + slNo;
      var ts = r; // fallback: row order
      if (iUpdatedAt >= 0) {
        var d = new Date(values[r][iUpdatedAt]);
        if (!isNaN(d.getTime())) ts = d.getTime();
      }

      if (!seen[key] || ts >= seen[key].ts) {
        seen[key] = { rowIndex: r, ts: ts };
      }
    }

    // Build set of row indexes to keep (one per booth+slNo)
    var keepRows = {};
    Object.keys(seen).forEach(function(k) {
      keepRows[seen[k].rowIndex] = true;
    });

    // Count duplicates being removed
    var duplicateCount = 0;
    for (var r2 = 1; r2 < values.length; r2++) {
      var b2 = toNumber_(values[r2][iBooth]);
      var s2 = toNumber_(values[r2][iSlNo]);
      if (b2 && s2 && !keepRows[r2]) duplicateCount++;
    }

    // Rebuild sheet: header + one row per unique booth+slNo
    var clean = [values[0]];
    for (var r3 = 1; r3 < values.length; r3++) {
      var b3 = toNumber_(values[r3][iBooth]);
      var s3 = toNumber_(values[r3][iSlNo]);
      if (!b3 || !s3 || keepRows[r3]) {
        clean.push(values[r3]);
      }
    }

    sheet.clearContents();
    if (clean.length > 0) {
      sheet.getRange(1, 1, clean.length, values[0].length).setValues(clean);
    }

    Logger.log('Deduplication complete. Removed ' + duplicateCount + ' duplicate rows. Kept ' + (clean.length - 1) + ' data rows.');
  } finally {
    lock.releaseLock();
  }
}

function readBooleanFlag_(value) {
  if (value === true) return true;
  var normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}

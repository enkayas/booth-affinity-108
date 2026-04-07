# Final Release Checklist

## 1) Dashboard Data Check (Completed)
- Frontend status: wired to call `action=getDashboardSummary` first, then fallback to partial booth refresh.
- Verification: current backend response to summary API is `{"ok":false,"message":"Unknown action"}`.
- Required backend action: add `getDashboardSummary` in Apps Script and deploy a new web app version.

Quick API test after backend deployment:
- `https://script.google.com/macros/s/<WEB_APP_ID>/exec?action=getDashboardSummary&mandal=__all__&village=`
- Expected: `{"ok":true,"booths":[...]}`

## 2) Role Access Check (Completed)
Frontend rules in `app.js`:
- Dashboard visible roles: `sakthi kendra`, `mandal president`, `manager`, `admin`.
- Data Refresh tab: only `admin`.
- Entry tab: all roles.

Static data role presence verified in `booth_affinity_static_data.json`:
- `Sakthi Kendra`, `Mandal President`, `ADMIN`, `MANAGER` are present.

## 3) Final Commit + Deploy Steps (Ready)
Run from repo root:

```bash
git status --short
git add app.js styles.css index.html booth_affinity_static_data.json FINAL_RELEASE_CHECKLIST.md
# Use only files that actually changed in your working tree.

git commit -m "Improve dashboard accuracy and performance"
git push origin main
```

Netlify final deploy:
- Re-enable auto deploy (if paused), or trigger one manual deploy.
- Validate production:
  - Dashboard opens quickly
  - Total Booths Completed and Total Voters Completed match expected values
  - Booth tile color/status is correct for known completed booth(s)
  - Booth Entry row lock/edit checkbox behavior still works

## Rollback Plan
If production numbers look wrong:

```bash
git log --oneline -5
git revert <commit_sha>
git push origin main
```

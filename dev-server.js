#!/usr/bin/env node
/**
 * Local dev server for Booth Affinity
 *
 * Usage:  node dev-server.js
 *         node dev-server.js 4000        (custom port)
 *
 * What it does:
 *   - Serves all static files (HTML, CSS, JSON …)
 *   - Serves app.js with API_URL patched to point at /mock-api
 *   - /mock-api  handles JSONP GET (getSavedAffinity, getDashboardSummary)
 *               and JSON  POST (saveBoothAffinities, clearBoothData)
 *
 * No npm install needed — pure Node built-ins only.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT    = Number(process.argv[2]) || 3000;
const ROOT    = __dirname;
const API_URL = `http://localhost:${PORT}/mock-api`;

// ── In-memory store: { [boothNo]: { [slNo]: { affinity, relocated, voted } } }
const store = {};

// ── MIME types
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Load static data once for getDashboardSummary mock
let staticData = null;
try {
  staticData = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'booth_affinity_static_data.json'), 'utf8')
  );
} catch (e) {
  console.warn('Could not load booth_affinity_static_data.json:', e.message);
}

// ── Seed realistic test data (first 40 booths with varied completion rates)
function seedTestData() {
  if (!staticData || !Array.isArray(staticData.booths)) return;
  staticData.booths.slice(0, 40).forEach((booth, idx) => {
    const boothNo   = Number(booth.booth);
    const total     = Number(booth.totalVoters) || 100;
    const fillRate  = idx < 10 ? 1.0 : idx < 25 ? 0.6 : 0.25;
    const fillCount = Math.round(total * fillRate);
    store[boothNo]  = {};
    for (let sl = 1; sl <= fillCount; sl++) {
      const r        = Math.random();
      const affinity = r < 0.40 ? 'A' : r < 0.65 ? 'B' : r < 0.80 ? 'C' : r < 0.90 ? 'D' : 'E';
      store[boothNo][sl] = { affinity, relocated: sl % 20 === 0, voted: sl % 15 === 0 };
    }
  });
  console.log('  Test data seeded for first 40 booths.');
}
seedTestData();

// ── Helpers

function jsonpResponse(callback, obj) {
  if (callback) return `${callback}(${JSON.stringify(obj)});`;
  return JSON.stringify(obj);
}

function buildDashboardSummary(params) {
  if (!staticData || !Array.isArray(staticData.booths)) {
    return { ok: false, message: 'Static data not loaded' };
  }

  const mandalFilter  = (params.mandal  || '').trim().toLowerCase();
  const villageFilter = (params.village || '').trim().toLowerCase();

  const booths = staticData.booths
    .filter(b => {
      if (mandalFilter && mandalFilter !== '__all__') {
        if ((b.mandal || '').trim().toLowerCase() !== mandalFilter) return false;
      }
      if (villageFilter && villageFilter !== '__all__') {
        if ((b.village || '').trim().toLowerCase() !== villageFilter) return false;
      }
      return true;
    })
    .map(b => {
      const boothNo  = Number(b.booth);
      const boothStore = store[boothNo] || {};
      const summary  = { A: 0, B: 0, C: 0, D: 0, E: 0 };
      let relocated = 0, voted = 0;

      Object.values(boothStore).forEach(v => {
        if (summary[v.affinity] !== undefined) summary[v.affinity]++;
        if (v.relocated) relocated++;
        if (v.voted) voted++;
      });

      const completed = summary.A + summary.B + summary.C + summary.D + summary.E;
      const total     = Number(b.totalVoters) || 0;
      const pct       = total ? Math.round((completed / total) * 100) : 0;

      return {
        booth:        boothNo,
        mandal:       b.mandal  || '',
        village:      b.village || '',
        totalVoters:  total,
        completed,
        completionPct: pct,
        summary,
        relocated_tot: relocated,
        voted_tot:     voted,
      };
    });

  return { ok: true, booths };
}

// ── Mock API handler

function handleMockApi(req, res) {
  const parsed = url.parse(req.url, true);
  const params = parsed.query;

  // ── GET (JSONP)
  if (req.method === 'GET') {
    const action   = String(params.action || '').trim();
    const callback = params.callback || '';
    let result;

    if (action === 'getDashboardSummary') {
      result = buildDashboardSummary(params);

    } else if (action === 'getSavedAffinity') {
      const boothNo = Number(params.booth);
      if (!boothNo) {
        result = { ok: false, message: 'Invalid booth' };
      } else {
        const boothStore = store[boothNo] || {};
        const saved = Object.entries(boothStore)
          .map(([slNo, v]) => ({ slNo: Number(slNo), ...v }))
          .sort((a, b) => a.slNo - b.slNo);
        result = { ok: true, saved };
      }

    } else {
      result = { ok: false, message: `Unknown GET action: ${action}` };
    }

    const body = jsonpResponse(callback, result);
    res.writeHead(200, {
      'Content-Type': callback ? 'application/javascript' : 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    return;
  }

  // ── POST (JSON)
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}

      const action  = String(body.action || '').trim();
      const boothNo = Number(body.booth);
      let result;

      if (action === 'saveBoothAffinities') {
        if (!boothNo || !Array.isArray(body.voters)) {
          result = { ok: false, message: 'Invalid payload' };
        } else {
          store[boothNo] = {};
          const summary = { A: 0, B: 0, C: 0, D: 0, E: 0 };
          let relocated = 0, voted = 0;

          body.voters.forEach(v => {
            const slNo     = Number(v.slNo);
            const affinity = String(v.affinity || '').trim().toUpperCase();
            if (!slNo || !/^[A-E]$/.test(affinity)) return;
            store[boothNo][slNo] = {
              affinity,
              relocated: !!v.relocated,
              voted:     !!v.voted,
            };
            summary[affinity]++;
            if (v.relocated) relocated++;
            if (v.voted)     voted++;
          });

          const completed    = summary.A + summary.B + summary.C + summary.D + summary.E;
          const boothConfig  = staticData?.booths?.find(b => Number(b.booth) === boothNo);
          const totalVoters  = Number(boothConfig?.totalVoters) || 0;
          const completionPct = totalVoters ? Math.round((completed / totalVoters) * 100) : 0;

          result = { ok: true, summary, completionPct, relocatedTotal: relocated, votedTotal: voted };
          console.log(`  [mock] saved booth ${boothNo}: ${completed} voters tagged`);
        }

      } else if (action === 'clearBoothData') {
        if (!boothNo) {
          result = { ok: false, message: 'Invalid booth' };
        } else {
          delete store[boothNo];
          result = { ok: true, message: 'Booth data cleared', completionPct: 0 };
          console.log(`  [mock] cleared booth ${boothNo}`);
        }

      } else {
        result = { ok: false, message: `Unknown POST action: ${action}` };
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // ── CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
}

// ── Static file handler

function handleStatic(req, res) {
  let filePath = url.parse(req.url).pathname;
  if (filePath === '/') filePath = '/index.html';

  const absPath = path.join(ROOT, filePath);

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext      = path.extname(filePath);
    const mimeType = MIME[ext] || 'application/octet-stream';

    const noCache = { 'Cache-Control': 'no-store' };

    // Patch app.js: replace API_URL and swap JSONP callApi → fetch (Safari-safe)
    if (filePath === '/app.js') {
      let patched = data.toString('utf8');

      // 1. Point API_URL at local mock
      patched = patched.replace(
        /^const API_URL\s*=\s*'[^']*';/m,
        `const API_URL = '${API_URL}'; // patched by dev-server`
      );

      // 2. Replace JSONP-based callApi with a simple fetch version.
      //    Safari blocks script-tag JSONP from localhost; fetch works fine.
      patched = patched.replace(
        /function callApi\(payload\)\s*\{[\s\S]*?^\}/m,
        `function callApi(payload) {
  const params = new URLSearchParams(payload);
  return fetch(API_URL + '?' + params.toString())
    .then(function(r) { return r.json(); });
}`
      );

      res.writeHead(200, { 'Content-Type': mimeType, ...noCache });
      res.end(patched);
      return;
    }

    res.writeHead(200, { 'Content-Type': mimeType, ...noCache });
    res.end(data);
  });
}

// ── Main server

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  console.log(`${req.method} ${pathname}`);

  if (pathname === '/mock-api') {
    handleMockApi(req, res);
  } else {
    handleStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`\nBooth Affinity dev server running at http://localhost:${PORT}\n`);
  console.log('  API_URL patched → /mock-api (in-memory store)');
  console.log('  Static data     → booth_affinity_static_data.json');
  console.log('\nPress Ctrl+C to stop.\n');
});

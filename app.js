const API_URL = 'https://script.google.com/macros/s/AKfycbzjoXHcSGmvVQjBi6OCjzsqlo1Rs7O2yyaSO7HNmjbZLizc5wA2FjsUu0Oushgrk-9C/exec';

const state = { user: null, booths: [], currentBooth: null, boothData: null };
const el = (id) => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(name).classList.add('active');
}

async function api(action, payload = {}) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
  return await response.json();
}

function renderUser() {
  el('welcomeText').textContent = `Welcome, ${state.user.name}`;
  el('roleText').textContent = `${state.user.role} • ${state.user.mandal}`;
}

function renderBoothOptions() {
  el('boothSelect').innerHTML = state.booths.map(b => `<option value="${b.booth}">Booth ${b.booth} - ${b.village}</option>`).join('');
}

function renderBoothMeta() {
  const b = state.currentBooth;
  el('boothMeta').innerHTML = `
    <div><strong>Booth:</strong> ${b.booth}</div>
    <div><strong>Village/Town:</strong> ${b.village}</div>
    <div><strong>Mandal:</strong> ${b.mandal}</div>
    <div><strong>Polling Station:</strong> ${b.pollingStation}</div>
    <div><strong>Total Voters:</strong> ${b.totalVoters}</div>`;
}

function renderSummary() {
  const s = state.boothData.summary;
  const pct = state.boothData.completionPct || 0;
  el('summaryCard').innerHTML = `
    <div class="pill a">A<br>${s.A || 0}</div>
    <div class="pill b">B<br>${s.B || 0}</div>
    <div class="pill c">C<br>${s.C || 0}</div>
    <div class="pill d">D<br>${s.D || 0}</div>
    <div class="pill e">E<br>${s.E || 0}</div>
    <div class="pill">Done<br>${pct}%</div>`;
}

function affinityClass(code) { return code ? code.toLowerCase() : 'd'; }

function renderSerials() {
  const list = el('serialList');
  const items = state.boothData.voters;
  list.innerHTML = items.map(row => `
    <div class="serial-row" id="serial-${row.slNo}">
      <div><strong>${row.slNo}</strong></div>
      <div class="affinity-buttons">
        ${['A','B','C','D','E'].map(code => `<button class="affinity-btn ${affinityClass(code)} ${row.affinity===code ? 'selected':''}" data-sl="${row.slNo}" data-code="${code}">${code}</button>`).join('')}
      </div>
      <div class="save-state" id="save-${row.slNo}">${row.affinity ? 'Saved' : ''}</div>
    </div>`).join('');

  document.querySelectorAll('.affinity-btn').forEach(btn => btn.addEventListener('click', onAffinityClick));
}

async function loadBooth(boothNo) {
  const result = await api('getBoothData', { phone: state.user.phone, booth: Number(boothNo) });
  if (!result.ok) return alert(result.message || 'Failed to load booth');
  state.currentBooth = result.booth;
  state.boothData = result.data;
  renderBoothMeta();
  renderSummary();
  renderSerials();
}

async function onAffinityClick(evt) {
  const slNo = Number(evt.target.dataset.sl);
  const affinity = evt.target.dataset.code;
  el(`save-${slNo}`).textContent = 'Saving...';
  const result = await api('saveAffinity', { phone: state.user.phone, booth: state.currentBooth.booth, slNo, affinity });
  if (!result.ok) {
    el(`save-${slNo}`).textContent = 'Failed';
    return;
  }
  await loadBooth(state.currentBooth.booth);
  const row = el(`serial-${slNo}`); if (row) row.scrollIntoView({ block: 'center' });
}

async function login() {
  const phone = el('phoneInput').value.trim();
  const password = el('passwordInput').value.trim();
  const result = await api('login', { phone, password });
  if (!result.ok) { el('loginMsg').textContent = result.message || 'Login failed'; return; }
  state.user = result.user;
  state.booths = result.booths;
  renderUser();
  renderBoothOptions();
  showScreen('dashboardScreen');
  await loadBooth(state.booths[0].booth);
}

el('loginBtn').addEventListener('click', login);
el('logoutBtn').addEventListener('click', () => location.reload());
el('boothSelect').addEventListener('change', (e) => loadBooth(e.target.value));
el('serialSearch').addEventListener('change', (e) => {
  const n = e.target.value;
  const row = el(`serial-${n}`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

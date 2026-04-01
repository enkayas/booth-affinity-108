const API_URL = 'https://script.google.com/macros/s/AKfycbzjoXHcSGmvVQjBi6OCjzsqlo1Rs7O2yyaSO7HNmjbZLizc5wA2FjsUu0Oushgrk-9C/exec';

const state = {
  staticData: null,
  user: null,
  booths: [],
  selectedBooth: null,
  boothData: null,
  localAffinityMap: {}
};

const els = {};

function byId(id) {
  return document.getElementById(id);
}

function showLoading(show) {
  if (els.loading) {
    els.loading.style.display = show ? 'flex' : 'none';
  }
}

function setLoginError(msg) {
  if (els.loginError) els.loginError.textContent = msg || '';
}

async function loadStaticData() {
  const res = await fetch('booth_affinity_static_data.json');
  if (!res.ok) throw new Error('Unable to load static data');
  state.staticData = await res.json();
}

function callApi(payload) {
  return new Promise((resolve, reject) => {
    const callbackName = 'jsonp_cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const params = new URLSearchParams(payload);
    params.set('callback', callbackName);

    const script = document.createElement('script');
    script.src = `${API_URL}?${params.toString()}`;

    let done = false;

    window[callbackName] = function(data) {
      done = true;
      try {
        resolve(data);
      } finally {
        delete window[callbackName];
        script.remove();
      }
    };

    script.onerror = function() {
      if (!done) {
        delete window[callbackName];
        script.remove();
        reject(new Error('Backend call failed'));
      }
    };

    document.body.appendChild(script);

    setTimeout(() => {
      if (!done) {
        delete window[callbackName];
        script.remove();
        reject(new Error('Backend timeout'));
      }
    }, 15000);
  });
}

async function postApi(payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

function renderUser() {
  if (!state.user) return;
  els.userName.textContent = state.user.name || '';
  els.userMeta.textContent = `${state.user.role || ''} • ${state.user.mandal || ''}`;
}

function renderBoothDropdown() {
  els.boothSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select Booth';
  els.boothSelect.appendChild(defaultOpt);

  state.booths.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.booth;
    opt.textContent = `Booth ${b.booth} - ${b.village || ''}`;
    els.boothSelect.appendChild(opt);
  });
}

function renderBoothDetails() {
  const b = state.selectedBooth;
  if (!b) {
    els.boothDetails.innerHTML = '<div class="muted">Select a booth to see details</div>';
    return;
  }

  els.boothDetails.innerHTML = `
    <div class="detail-grid">
      <div><strong>Booth</strong><span>${b.booth}</span></div>
      <div><strong>Village/Town</strong><span>${b.village || ''}</span></div>
      <div><strong>Mandal</strong><span>${b.mandal || ''}</span></div>
      <div><strong>Polling Station</strong><span>${b.pollingStation || ''}</span></div>
      <div><strong>Total Voters</strong><span>${b.totalVoters || 0}</span></div>
    </div>
  `;
}

function calculateSummary(voters) {
  const summary = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let filled = 0;

  voters.forEach(v => {
    if (summary.hasOwnProperty(v.affinity)) summary[v.affinity]++;
    if (v.affinity) filled++;
  });

  const completionPct = state.selectedBooth?.totalVoters
    ? Math.round((filled / state.selectedBooth.totalVoters) * 100)
    : 0;

  return { summary, completionPct };
}

function renderSummary() {
  const s = state.boothData?.summary || { A: 0, B: 0, C: 0, D: 0, E: 0 };
  els.summaryA.textContent = s.A || 0;
  els.summaryB.textContent = s.B || 0;
  els.summaryC.textContent = s.C || 0;
  els.summaryD.textContent = s.D || 0;
  els.summaryE.textContent = s.E || 0;
  els.completionPct.textContent = `${state.boothData?.completionPct || 0}%`;
}

function affinityButton(code, current, slNo) {
  const active = current === code ? 'active' : '';
  return `
    <button class="affinity-btn affinity-${code} ${active}" data-sl="${slNo}" data-affinity="${code}" type="button">
      ${code}
    </button>
  `;
}

function renderVoters() {
  const voters = state.boothData?.voters || [];
  if (!voters.length) {
    els.votersContainer.innerHTML = '<div class="muted">No voters found for this booth</div>';
    return;
  }

  els.votersContainer.innerHTML = `
    <div style="margin-bottom:12px;">
      <button id="saveBoothBtn" type="button">Save Booth</button>
    </div>
    ${voters.map(v => `
      <div class="voter-row">
        <div class="sl-box">SL# ${v.slNo}</div>
        <div class="affinity-group">
          ${affinityButton('A', v.affinity, v.slNo)}
          ${affinityButton('B', v.affinity, v.slNo)}
          ${affinityButton('C', v.affinity, v.slNo)}
          ${affinityButton('D', v.affinity, v.slNo)}
          ${affinityButton('E', v.affinity, v.slNo)}
        </div>
      </div>
    `).join('')}
  `;

  els.votersContainer.querySelectorAll('.affinity-btn').forEach(btn => {
    btn.addEventListener('click', onAffinityClick);
  });

  const saveBtn = byId('saveBoothBtn');
  if (saveBtn) saveBtn.addEventListener('click', onSaveBooth);
}

function updateLocalSelection(slNo, affinity) {
  const voter = state.boothData.voters.find(v => v.slNo === slNo);
  if (!voter) return;
  voter.affinity = affinity;

  const calc = calculateSummary(state.boothData.voters);
  state.boothData.summary = calc.summary;
  state.boothData.completionPct = calc.completionPct;

  renderSummary();
  renderVoters();
}

function onAffinityClick(e) {
  const btn = e.currentTarget;
  const slNo = Number(btn.dataset.sl);
  const affinity = btn.dataset.affinity;

  if (!slNo || !affinity) return;
  updateLocalSelection(slNo, affinity);
}

async function onSaveBooth() {
  try {
    showLoading(true);

    const result = await postApi({
      action: 'saveBoothAffinities',
      booth: state.selectedBooth.booth,
      voters: state.boothData.voters
    });

    if (!result.ok) {
      alert(result.message || 'Save failed');
      return;
    }

    alert('Booth saved');
  } catch (err) {
    alert(err.message || 'Save failed');
  } finally {
    showLoading(false);
  }
}

async function loadBoothData(booth) {
  const selected = state.booths.find(b => Number(b.booth) === Number(booth));
  if (!selected) throw new Error('Booth not found');

  state.selectedBooth = selected;

  const result = await callApi({
    action: 'getBoothData',
    booth
  });

  if (!result.ok) {
    throw new Error(result.message || 'Failed to load booth');
  }

  state.boothData = result.data;

  renderBoothDetails();
  renderSummary();
  renderVoters();
}

async function onBoothChange() {
  const booth = Number(els.boothSelect.value);

  if (!booth) {
    state.selectedBooth = null;
    state.boothData = null;
    renderBoothDetails();
    renderSummary();
    renderVoters();
    return;
  }

  try {
    showLoading(true);
    await loadBoothData(booth);
  } catch (err) {
    alert(err.message || 'Unable to load booth');
  } finally {
    showLoading(false);
  }
}

function getUserFromStatic(phone, password) {
  if (!state.staticData || !state.staticData.users) return null;

  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const cleanPassword = String(password || '').trim();

  return state.staticData.users.find(u => {
    const userPhone = String(u.phone || '').replace(/\D/g, '').slice(-10);
    return userPhone === cleanPhone && userPhone.slice(-4) === cleanPassword;
  }) || null;
}

function getBoothsForUser(user) {
  if (!state.staticData || !state.staticData.booths) return [];

  const allowed = Array.isArray(user.booths)
    ? user.booths.map(x => Number(x))
    : [];

  return state.staticData.booths
    .filter(b => allowed.includes(Number(b.booth)))
    .sort((a, b) => a.booth - b.booth);
}

async function onLoginSubmit(e) {
  e.preventDefault();
  setLoginError('');

  const phone = els.phone.value.trim();
  const password = els.password.value.trim();

  if (!phone || !password) {
    setLoginError('Enter phone number and password');
    return;
  }

  const user = getUserFromStatic(phone, password);

  if (!user) {
    setLoginError('Invalid phone or password');
    return;
  }

  state.user = {
    phone: user.phone,
    name: user.name,
    role: user.role,
    mandal: user.mandal
  };

  state.booths = getBoothsForUser(user);

  els.loginSection.style.display = 'none';
  els.appSection.style.display = 'block';

  renderUser();
  renderBoothDropdown();
  renderBoothDetails();
  renderSummary();
  renderVoters();
}

function logout() {
  state.user = null;
  state.booths = [];
  state.selectedBooth = null;
  state.boothData = null;

  els.phone.value = '';
  els.password.value = '';
  setLoginError('');

  els.loginSection.style.display = 'block';
  els.appSection.style.display = 'none';
}

async function init() {
  els.loginSection = byId('loginSection');
  els.appSection = byId('appSection');
  els.loginForm = byId('loginForm');
  els.phone = byId('phone');
  els.password = byId('password');
  els.loginError = byId('loginError');
  els.userName = byId('userName');
  els.userMeta = byId('userMeta');
  els.boothSelect = byId('boothSelect');
  els.boothDetails = byId('boothDetails');
  els.votersContainer = byId('votersContainer');
  els.summaryA = byId('summaryA');
  els.summaryB = byId('summaryB');
  els.summaryC = byId('summaryC');
  els.summaryD = byId('summaryD');
  els.summaryE = byId('summaryE');
  els.completionPct = byId('completionPct');
  els.logoutBtn = byId('logoutBtn');
  els.loading = byId('loading');

  await loadStaticData();

  els.loginForm.addEventListener('submit', onLoginSubmit);
  if (els.boothSelect) els.boothSelect.addEventListener('change', onBoothChange);
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', logout);

  renderBoothDetails();
  renderSummary();
  renderVoters();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    alert(err.message || 'App failed to load');
  });
});

const API_URL = 'https://script.google.com/macros/s/AKfycbzjoXHcSGmvVQjBi6OCjzsqlo1Rs7O2yyaSO7HNmjbZLizc5wA2FjsUu0Oushgrk-9C/exec';

const state = {
  user: null,
  booths: [],
  selectedBooth: null,
  boothData: null
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

  if (state.booths.length === 1) {
    els.boothSelect.value = String(state.booths[0].booth);
    onBoothChange();
  }
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

  els.votersContainer.innerHTML = voters.map(v => `
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
  `).join('');

  els.votersContainer.querySelectorAll('.affinity-btn').forEach(btn => {
    btn.addEventListener('click', onAffinityClick);
  });
}

async function onAffinityClick(e) {
  const btn = e.currentTarget;
  const slNo = Number(btn.dataset.sl);
  const affinity = btn.dataset.affinity;
  const booth = state.selectedBooth?.booth;

  if (!booth || !slNo || !affinity) return;

  try {
    showLoading(true);
    const result = await callApi({
      action: 'saveAffinity',
      booth,
      slNo,
      affinity
    });

    if (!result.ok) {
      alert(result.message || 'Save failed');
      return;
    }

    await loadBoothData(booth);
  } catch (err) {
    alert(err.message || 'Save failed');
  } finally {
    showLoading(false);
  }
}

async function loadBoothData(booth) {
  const result = await callApi({
    action: 'getBoothData',
    booth
  });

  if (!result.ok) {
    throw new Error(result.message || 'Failed to load booth');
  }

  state.selectedBooth = result.booth;
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

async function onLoginSubmit(e) {
  e.preventDefault();
  setLoginError('');

  const phone = els.phone.value.trim();
  const password = els.password.value.trim();

  if (!phone || !password) {
    setLoginError('Enter phone number and password');
    return;
  }

  try {
    showLoading(true);

    const result = await callApi({
      action: 'login',
      phone,
      password
    });

    if (!result.ok) {
      setLoginError(result.message || 'Login failed');
      return;
    }

    state.user = result.user;
    state.booths = result.booths || [];

    els.loginSection.style.display = 'none';
    els.appSection.style.display = 'block';

    renderUser();
    renderBoothDropdown();
    renderBoothDetails();
    renderSummary();
    renderVoters();
  } catch (err) {
    setLoginError(err.message || 'Login failed');
  } finally {
    showLoading(false);
  }
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

function init() {
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

  if (!els.loginForm) {
    alert('loginForm not found in HTML');
    return;
  }

  els.loginForm.addEventListener('submit', onLoginSubmit);
  if (els.boothSelect) els.boothSelect.addEventListener('change', onBoothChange);
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', logout);

  renderBoothDetails();
  renderSummary();
  renderVoters();
}

document.addEventListener('DOMContentLoaded', init);

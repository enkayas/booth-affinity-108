const API_URL = 'https://script.google.com/macros/s/AKfycbzjoXHcSGmvVQjBi6OCjzsqlo1Rs7O2yyaSO7HNmjbZLizc5wA2FjsUu0Oushgrk-9C/exec';
const DRAFT_STORAGE_KEY = 'booth_affinity_drafts_v1';
const DRAFT_PERSIST_DELAY_MS = 120;
const RETRY_SYNC_DELAY_MS = 5000;
const DASHBOARD_RENDER_DELAY_MS = 120;
const STATIC_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DASHBOARD_VISIBLE_ROLES = new Set(['sakthi kendra', 'mandal president', 'manager', 'admin']);

const state = {
  staticData: null,
  user: null,
  allBooths: [],
  allBoothMap: new Map(),
  booths: [],
  boothMap: new Map(),
  selectedMandal: '',
  selectedBoothAll: false,
  dashboardSelectedMandal: '',
  dashboardSelectedVillage: '',
  selectedBooth: null,
  boothData: null,
  currentPage: 1,
  pageSize: 20,
  pageCache: {},
  pendingBoothLoads: {},
  prefetchStarted: false,
  localDrafts: {},
  editingRows: new Set(),
  pendingSaveTimer: null,
  pendingDraftPersistTimer: null,
  retrySyncTimer: null,
  syncInProgress: false,
  pendingDashboardRenderTimer: null,
  activeBoothLoadId: 0,
  staticRefreshTimer: null,
  activeView: 'entry',
  dataRefreshLogs: [],
  dataRefreshInProgress: false
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

function setAffinitySaveStatus(msg, tone = 'muted') {
  if (!els.affinitySaveStatus) return;
  els.affinitySaveStatus.textContent = msg || '';
  const colors = {
    muted: '#6b7280',
    success: '#15803d',
    warning: '#b45309',
    error: '#c62828'
  };
  els.affinitySaveStatus.style.color = colors[tone] || colors.muted;
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function canViewDashboard() {
  return DASHBOARD_VISIBLE_ROLES.has(normalizeRole(state.user?.role));
}

function canUseDataRefresh() {
  return normalizeRole(state.user?.role) === 'admin';
}

function getDraftStorageId() {
  return String(state.user?.phone || 'anonymous');
}

function readLocalDrafts() {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const drafts = parsed[getDraftStorageId()];
    return drafts && typeof drafts === 'object' ? drafts : {};
  } catch (err) {
    console.error('Unable to read local drafts:', err.message || err);
    return {};
  }
}

function writeLocalDrafts() {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const store = parsed && typeof parsed === 'object' ? parsed : {};
    const storageId = getDraftStorageId();
    const keys = Object.keys(state.localDrafts || {});
    if (keys.length) {
      store[storageId] = state.localDrafts;
    } else {
      delete store[storageId];
    }

    if (!Object.keys(store).length) {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.error('Unable to write local drafts:', err.message || err);
  }
}

function getCurrentBoothNumber() {
  return Number(state.selectedBooth?.booth) || 0;
}

function formatTimestamp(value = Date.now()) {
  try {
    return new Date(value).toLocaleString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (_) {
    return String(value);
  }
}

async function loadStaticData(options = {}) {
  const url = options.forceRefresh
    ? `booth_affinity_static_data.json?ts=${Date.now()}`
    : 'booth_affinity_static_data.json';
  const res = await fetch(url, {
    cache: options.forceRefresh ? 'no-store' : 'default'
  });
  if (!res.ok) throw new Error('Unable to load static data');
  const data = await res.json();
  state.staticData = data;
  return data;
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

async function postApi(payload, options = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    keepalive: !!options.keepalive
  });
  return res.json();
}

function renderUser() {
  if (!state.user) return;
  const mandal = state.user.mandal || '';
  els.userName.textContent = mandal ? `Booth Insights | ${mandal}` : 'Booth Insights';
  els.userMeta.textContent = `${state.user.name || ''} | ${state.user.role || ''}`;
}

function renderBoothDropdown() {
  els.boothSelect.innerHTML = '';
  const canUseAllOptions = requiresMandalSelection();

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = canUseAllOptions && !state.selectedMandal
    ? 'Select Mandal First'
    : 'Select a Booth';
  els.boothSelect.appendChild(defaultOpt);

  if (canUseAllOptions && state.booths.length) {
    const allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = 'All';
    els.boothSelect.appendChild(allOpt);
  }

  state.booths.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.booth;
    opt.textContent = `Booth ${b.booth} - ${b.village || ''}`;
    els.boothSelect.appendChild(opt);
  });
}

function requiresMandalSelection() {
  const role = normalizeRole(state.user?.role);
  return role === 'admin' || role === 'manager';
}

function getAvailableMandals() {
  return Array.from(new Set(
    (state.allBooths || [])
      .map(booth => String(booth.mandal || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
}

function getDashboardAvailableMandals() {
  return Array.from(new Set(
    (state.allBooths || [])
      .map(booth => String(booth.mandal || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
}

function getDashboardVillageOptions() {
  const scopedByMandal = state.dashboardSelectedMandal
    ? (state.allBooths || []).filter(booth => String(booth.mandal || '').trim() === state.dashboardSelectedMandal)
    : (state.allBooths || []);

  return Array.from(new Set(
    scopedByMandal
      .map(booth => String(booth.village || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
}

function syncDashboardFilterState() {
  const mandals = getDashboardAvailableMandals();
  if (state.dashboardSelectedMandal && !mandals.includes(state.dashboardSelectedMandal)) {
    state.dashboardSelectedMandal = '';
  }

  const villages = getDashboardVillageOptions();
  if (state.dashboardSelectedVillage && !villages.includes(state.dashboardSelectedVillage)) {
    state.dashboardSelectedVillage = '';
  }
}

function getDashboardScopedBooths() {
  let scopedBooths = [...(state.allBooths || [])];

  if (state.dashboardSelectedMandal) {
    scopedBooths = scopedBooths.filter(
      booth => String(booth.mandal || '').trim() === state.dashboardSelectedMandal
    );
  }

  if (state.dashboardSelectedVillage) {
    scopedBooths = scopedBooths.filter(
      booth => String(booth.village || '').trim() === state.dashboardSelectedVillage
    );
  }

  return scopedBooths.sort((a, b) => Number(a.booth) - Number(b.booth));
}

function renderDashboardFilters() {
  if (!els.dashboardFilters || !els.dashboardMandalSelect || !els.dashboardVillageSelect) return;

  if (!canViewDashboard()) {
    els.dashboardFilters.style.display = 'none';
    return;
  }

  els.dashboardFilters.style.display = 'grid';
  syncDashboardFilterState();

  const mandals = getDashboardAvailableMandals();
  els.dashboardMandalSelect.innerHTML = '';
  const defaultMandalOpt = document.createElement('option');
  defaultMandalOpt.value = '';
  defaultMandalOpt.textContent = mandals.length > 1 ? 'All Mandals' : (mandals[0] || 'All Mandals');
  els.dashboardMandalSelect.appendChild(defaultMandalOpt);

  mandals.forEach(mandal => {
    const opt = document.createElement('option');
    opt.value = mandal;
    opt.textContent = mandal;
    els.dashboardMandalSelect.appendChild(opt);
  });
  els.dashboardMandalSelect.value = state.dashboardSelectedMandal || '';

  const villages = getDashboardVillageOptions();
  els.dashboardVillageSelect.innerHTML = '';
  const defaultVillageOpt = document.createElement('option');
  defaultVillageOpt.value = '';
  defaultVillageOpt.textContent = villages.length > 1 ? 'All Villages/Towns' : (villages[0] || 'All Villages/Towns');
  els.dashboardVillageSelect.appendChild(defaultVillageOpt);

  villages.forEach(village => {
    const opt = document.createElement('option');
    opt.value = village;
    opt.textContent = village;
    els.dashboardVillageSelect.appendChild(opt);
  });
  els.dashboardVillageSelect.value = state.dashboardSelectedVillage || '';
}

function renderMandalDropdown() {
  if (!els.mandalFilterGroup || !els.mandalSelect) return;

  const showFilter = requiresMandalSelection();
  els.mandalFilterGroup.style.display = showFilter ? 'block' : 'none';

  if (!showFilter) {
    els.mandalSelect.innerHTML = '<option value="">Select Mandal</option>';
    return;
  }

  const mandals = getAvailableMandals();
  els.mandalSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select Mandal';
  els.mandalSelect.appendChild(defaultOpt);

  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = 'ALL';
  els.mandalSelect.appendChild(allOpt);

  mandals.forEach(mandal => {
    const opt = document.createElement('option');
    opt.value = mandal;
    opt.textContent = mandal;
    els.mandalSelect.appendChild(opt);
  });

  els.mandalSelect.value = state.selectedMandal || '';
}

function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return String(phone || '');
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

function renderBoothMetaSummary() {
  const b = state.selectedBooth;
  if (!els.boothMetaSummary) return;

  if (state.selectedBoothAll) {
    const totalVoters = state.booths.reduce((sum, booth) => sum + (Number(booth.totalVoters) || 0), 0);
    const mandalLabel = state.selectedMandal === '__all__' ? 'ALL' : (state.selectedMandal || 'All Mandals');
    els.boothMetaSummary.innerHTML = `
      <div class="mini-detail-row">
        <div><strong>Booth #</strong><span>All Booths</span></div>
        <div><strong>Mandal</strong><span>${mandalLabel}</span></div>
        <div><strong>Total Voters</strong><span>${totalVoters}</span></div>
      </div>
    `;
    return;
  }

  if (!b) {
    els.boothMetaSummary.innerHTML = '<div class="muted">Booth, mandal, and voter count will appear here</div>';
    return;
  }

  els.boothMetaSummary.innerHTML = `
    <div class="mini-detail-row">
      <div><strong>Booth #</strong><span>${b.booth}</span></div>
      <div><strong>Mandal</strong><span>${b.mandal || ''}</span></div>
      <div><strong>Total Voters</strong><span>${b.totalVoters || 0}</span></div>
    </div>
  `;
}

function getBoothContacts(booth) {
  if (!state.staticData?.users || !booth) return [];

  const boothNo = Number(booth);
  const roleOrder = ['Mandal President', 'Sakthi Kendra', 'BLA2', 'Booth President'];

  return state.staticData.users
    .filter(u => Array.isArray(u.booths) && u.booths.includes(boothNo) && roleOrder.includes(u.role))
    .sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
}

function getSelectionMandalLabel() {
  if (state.selectedBooth?.mandal) return state.selectedBooth.mandal;
  if (state.selectedMandal === '__all__') return 'ALL';
  return state.selectedMandal || 'Not selected';
}

function getMandalPresidentForSelection() {
  if (!state.staticData?.users) return null;
  const mandal = getSelectionMandalLabel();
  if (!mandal || mandal === 'ALL' || mandal === 'Not selected') return null;

  return state.staticData.users.find(user =>
    normalizeRole(user.role) === 'mandal president' &&
    String(user.mandal || '').trim() === mandal
  ) || null;
}

function renderSelectionContactCards(contactMap, fallbackLabel) {
  const roleOrder = ['Mandal President', 'Sakthi Kendra', 'BLA2', 'Booth President'];
  return roleOrder.map(role => {
    const contact = contactMap.get(role);
    return `
      <div class="contact-card${contact ? '' : ' contact-card-missing'}">
        <strong>${role}</strong>
        <span>${contact?.name || fallbackLabel}</span>
        <span>${contact?.phone ? formatPhone(contact.phone) : '-'}</span>
      </div>
    `;
  }).join('');
}

function renderBoothDetails() {
  const b = state.selectedBooth;
  const mandalLabel = getSelectionMandalLabel();
  if (state.selectedBoothAll) {
    renderBoothMetaSummary();
    const boothCount = state.booths.length;
    const mandalPresident = getMandalPresidentForSelection();
    const contactMap = new Map();
    if (mandalPresident) {
      contactMap.set('Mandal President', mandalPresident);
    }
    els.boothDetails.innerHTML = `
      <div class="booth-details-layout">
        <div class="detail-grid detail-grid-selection">
          <div><strong>Mandal</strong><span>${mandalLabel}</span></div>
          <div><strong>Selection Scope</strong><span>All Booths (${boothCount})</span></div>
        </div>
        <div class="contact-grid">
          ${renderSelectionContactCards(contactMap, 'Select a booth')}
        </div>
      </div>
    `;
    return;
  }

  if (!b) {
    renderBoothMetaSummary();
    const mandalPresident = getMandalPresidentForSelection();
    const contactMap = new Map();
    if (mandalPresident) {
      contactMap.set('Mandal President', mandalPresident);
    }
    els.boothDetails.innerHTML = `
      <div class="booth-details-layout">
        <div class="detail-grid detail-grid-selection">
          <div><strong>Mandal</strong><span>${mandalLabel}</span></div>
          <div><strong>Selection Scope</strong><span>Select a booth</span></div>
        </div>
        <div class="contact-grid">
          ${renderSelectionContactCards(contactMap, 'Select a booth')}
        </div>
      </div>
    `;
    return;
  }

  renderBoothMetaSummary();

  const contacts = getBoothContacts(b.booth);
  const contactMap = new Map(contacts.map(contact => [contact.role, contact]));
  els.boothDetails.innerHTML = `
    <div class="booth-details-layout">
      <div class="detail-grid detail-grid-selection">
        <div><strong>Mandal</strong><span>${mandalLabel}</span></div>
      </div>
      <div class="detail-grid detail-grid-location">
        <div><strong>Village/Town</strong><span>${b.village || ''}</span></div>
        <div><strong>Polling Station</strong><span>${b.pollingStation || ''}</span></div>
      </div>
      <div class="contact-grid">
        ${renderSelectionContactCards(contactMap, 'Not assigned')}
      </div>
    </div>
  `;
}

function calculateSummary(voters, totalVoters = state.selectedBooth?.totalVoters || 0) {
  const summary = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let filled = 0;

  voters.forEach(v => {
    if (summary.hasOwnProperty(v.affinity)) summary[v.affinity]++;
    if (v.affinity) filled++;
  });

  const completionPct = totalVoters
    ? Math.round((filled / totalVoters) * 100)
    : 0;

  return { summary, completionPct };
}

function createBoothData(totalVoters) {
  return {
    voters: buildBoothVoters(Number(totalVoters) || 0),
    summary: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    completionPct: 0
  };
}

function buildAggregateBoothData() {
  const summary = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const totalVoters = state.booths.reduce((sum, booth) => sum + (Number(booth.totalVoters) || 0), 0);

  state.booths.forEach(booth => {
    const cached = state.pageCache[Number(booth.booth)];
    if (!cached?.summary) return;
    summary.A += Number(cached.summary.A || 0);
    summary.B += Number(cached.summary.B || 0);
    summary.C += Number(cached.summary.C || 0);
    summary.D += Number(cached.summary.D || 0);
    summary.E += Number(cached.summary.E || 0);
  });

  const completed = summary.A + summary.B + summary.C + summary.D + summary.E;
  const completionPct = totalVoters ? Math.round((completed / totalVoters) * 100) : 0;

  return {
    voters: [],
    summary,
    completionPct
  };
}

function cloneBoothData(boothData) {
  if (!boothData) return null;

  return {
    voters: Array.isArray(boothData.voters)
      ? boothData.voters.map(v => ({ slNo: v.slNo, affinity: v.affinity || '' }))
      : [],
    summary: {
      A: boothData.summary?.A || 0,
      B: boothData.summary?.B || 0,
      C: boothData.summary?.C || 0,
      D: boothData.summary?.D || 0,
      E: boothData.summary?.E || 0
    },
    completionPct: boothData.completionPct || 0
  };
}

function buildDraftFromBoothData(boothData) {
  if (!boothData?.voters?.length) return null;

  const voters = boothData.voters
    .filter(v => v.affinity)
    .map(v => ({ slNo: v.slNo, affinity: v.affinity }));

  return {
    voters,
    updatedAt: Date.now()
  };
}

function setDraftForBooth(boothNo, boothData) {
  if (!boothNo || !boothData) return;
  const draft = buildDraftFromBoothData(boothData);
  if (!draft) return;
  state.localDrafts[String(boothNo)] = draft;
}

function clearDraftForBooth(boothNo) {
  if (!boothNo) return;
  delete state.localDrafts[String(boothNo)];
}

function getDraftForBooth(boothNo) {
  return state.localDrafts[String(boothNo)] || null;
}

function applyDraftToBoothData(boothData, boothNo, totalVoters = state.selectedBooth?.totalVoters || 0) {
  const draft = getDraftForBooth(boothNo);
  if (!draft?.voters?.length) return false;
  applySavedAffinity(draft.voters, boothData, totalVoters);
  return true;
}

function persistDraftsNow() {
  if (state.pendingDraftPersistTimer) {
    clearTimeout(state.pendingDraftPersistTimer);
    state.pendingDraftPersistTimer = null;
  }
  writeLocalDrafts();
}

function queueDraftPersist() {
  if (state.pendingDraftPersistTimer) {
    clearTimeout(state.pendingDraftPersistTimer);
  }

  state.pendingDraftPersistTimer = setTimeout(() => {
    writeLocalDrafts();
    state.pendingDraftPersistTimer = null;
  }, DRAFT_PERSIST_DELAY_MS);
}

function cacheCurrentBoothData() {
  const boothNo = Number(state.selectedBooth?.booth);
  if (!boothNo || !state.boothData) return;
  state.pageCache[boothNo] = cloneBoothData(state.boothData);
  queueDashboardRender();
}

function getBoothConfig(booth) {
  return state.allBoothMap.get(Number(booth)) || null;
}

function getDashboardScopeLabel() {
  const role = normalizeRole(state.user?.role);
  if (role === 'admin' || role === 'manager') return 'All mandals';
  if (role === 'mandal president') return `${state.user?.mandal || 'Assigned'} mandal`;
  if (role === 'sakthi kendra') return 'Assigned booths';
  return 'No dashboard access';
}

function setActiveView(view) {
  const canUseDashboard = canViewDashboard();
  const canRefreshData = canUseDataRefresh();
  if (view === 'dashboard' && canUseDashboard) {
    state.activeView = 'dashboard';
  } else if (view === 'data-refresh' && canRefreshData) {
    state.activeView = 'data-refresh';
  } else {
    state.activeView = 'entry';
  }
  renderAppTabs();
}

function renderAppTabs() {
  if (!els.appTabs || !els.entrySection || !els.dashboardSection || !els.entryTabBtn || !els.dashboardTabBtn || !els.dataRefreshSection || !els.dataRefreshTabBtn) {
    return;
  }

  const canUseDashboard = canViewDashboard();
  const canRefreshData = canUseDataRefresh();
  els.appTabs.style.display = canUseDashboard ? 'flex' : 'none';
  els.dashboardTabBtn.style.display = canUseDashboard ? 'inline-flex' : 'none';
  els.dataRefreshTabBtn.style.display = canRefreshData ? 'inline-flex' : 'none';

  if (!canUseDashboard && !canRefreshData) {
    state.activeView = 'entry';
  } else if (state.activeView === 'dashboard' && !canUseDashboard) {
    state.activeView = 'entry';
  } else if (state.activeView === 'data-refresh' && !canRefreshData) {
    state.activeView = 'entry';
  }

  const entryActive = state.activeView === 'entry';
  const dashboardActive = state.activeView === 'dashboard' && canUseDashboard;
  const dataRefreshActive = state.activeView === 'data-refresh' && canRefreshData;
  els.entrySection.style.display = entryActive ? 'block' : 'none';
  els.dashboardSection.style.display = dashboardActive ? 'block' : 'none';
  els.dataRefreshSection.style.display = dataRefreshActive ? 'block' : 'none';
  els.entryTabBtn.classList.toggle('active', entryActive);
  els.dashboardTabBtn.classList.toggle('active', dashboardActive);
  els.dataRefreshTabBtn.classList.toggle('active', dataRefreshActive);
}

function serializeBoothList(value) {
  if (value === 'all') return 'all';
  if (!Array.isArray(value)) return '';
  return value.map(Number).sort((a, b) => a - b).join(',');
}

function summarizeUserDiff(oldUser, newUser) {
  const changes = [];
  if ((oldUser?.name || '') !== (newUser?.name || '')) changes.push(`name: ${oldUser?.name || '-'} -> ${newUser?.name || '-'}`);
  if ((oldUser?.role || '') !== (newUser?.role || '')) changes.push(`role: ${oldUser?.role || '-'} -> ${newUser?.role || '-'}`);
  if ((oldUser?.mandal || '') !== (newUser?.mandal || '')) changes.push(`mandal: ${oldUser?.mandal || '-'} -> ${newUser?.mandal || '-'}`);
  if (serializeBoothList(oldUser?.booths) !== serializeBoothList(newUser?.booths)) changes.push('booths updated');
  return changes;
}

function summarizeBoothDiff(oldBooth, newBooth) {
  const changes = [];
  if ((oldBooth?.village || '') !== (newBooth?.village || '')) changes.push(`village: ${oldBooth?.village || '-'} -> ${newBooth?.village || '-'}`);
  if ((oldBooth?.mandal || '') !== (newBooth?.mandal || '')) changes.push(`mandal: ${oldBooth?.mandal || '-'} -> ${newBooth?.mandal || '-'}`);
  if ((oldBooth?.pollingStation || '') !== (newBooth?.pollingStation || '')) changes.push('polling station updated');
  if (Number(oldBooth?.totalVoters || 0) !== Number(newBooth?.totalVoters || 0)) changes.push(`total voters: ${oldBooth?.totalVoters || 0} -> ${newBooth?.totalVoters || 0}`);
  return changes;
}

function diffStaticData(oldData, newData) {
  const lines = [];
  const oldUsers = new Map((oldData?.users || []).map(user => [String(user.phone || ''), user]));
  const newUsers = new Map((newData?.users || []).map(user => [String(user.phone || ''), user]));
  const oldBooths = new Map((oldData?.booths || []).map(booth => [Number(booth.booth), booth]));
  const newBooths = new Map((newData?.booths || []).map(booth => [Number(booth.booth), booth]));

  let addedUsers = 0;
  let removedUsers = 0;
  let updatedUsers = 0;
  let addedBooths = 0;
  let removedBooths = 0;
  let updatedBooths = 0;

  newUsers.forEach((user, phone) => {
    if (!oldUsers.has(phone)) {
      addedUsers++;
      lines.push(`User added: ${phone} | ${user.name || '-'} | ${user.role || '-'}`);
      return;
    }
    const changes = summarizeUserDiff(oldUsers.get(phone), user);
    if (changes.length) {
      updatedUsers++;
      lines.push(`User updated: ${phone} | ${changes.join('; ')}`);
    }
  });

  oldUsers.forEach((user, phone) => {
    if (!newUsers.has(phone)) {
      removedUsers++;
      lines.push(`User removed: ${phone} | ${user.name || '-'} | ${user.role || '-'}`);
    }
  });

  newBooths.forEach((booth, boothNo) => {
    if (!oldBooths.has(boothNo)) {
      addedBooths++;
      lines.push(`Booth added: ${boothNo} | ${booth.village || '-'} | ${booth.mandal || '-'}`);
      return;
    }
    const changes = summarizeBoothDiff(oldBooths.get(boothNo), booth);
    if (changes.length) {
      updatedBooths++;
      lines.push(`Booth updated: ${boothNo} | ${changes.join('; ')}`);
    }
  });

  oldBooths.forEach((booth, boothNo) => {
    if (!newBooths.has(boothNo)) {
      removedBooths++;
      lines.push(`Booth removed: ${boothNo} | ${booth.village || '-'} | ${booth.mandal || '-'}`);
    }
  });

  const summary = `Users +${addedUsers} / -${removedUsers} / ~${updatedUsers}; Booths +${addedBooths} / -${removedBooths} / ~${updatedBooths}`;
  if (!lines.length) {
    lines.push('No changes detected between the current and refreshed static data.');
  }
  return { summary, lines };
}

function renderDataRefreshLog() {
  if (!els.dataRefreshLog || !els.dataRefreshStatus || !els.runDataRefreshBtn) return;

  els.runDataRefreshBtn.disabled = state.dataRefreshInProgress;
  els.dataRefreshStatus.textContent = state.dataRefreshInProgress
    ? 'Refreshing static source data...'
    : canUseDataRefresh()
      ? 'Admin-only manual refresh of the latest served static JSON.'
      : '';

  if (!state.dataRefreshLogs.length) {
    els.dataRefreshLog.innerHTML = '<div class="muted">No refreshes run in this session.</div>';
    return;
  }

  els.dataRefreshLog.innerHTML = state.dataRefreshLogs.map(entry => `
    <article class="refresh-log-entry">
      <div class="refresh-log-header">
        <strong>${entry.title}</strong>
        <span>${entry.timestamp}</span>
      </div>
      <div class="refresh-log-summary">${entry.summary}</div>
      <div class="refresh-log-lines">
        ${entry.lines.map(line => `<div class="refresh-log-line">${line}</div>`).join('')}
      </div>
    </article>
  `).join('');
}

function getAccessibleBoothStatusList(booths = state.booths) {
  return booths.map(booth => {
    const boothNo = Number(booth.booth);
    const cached = state.pageCache[boothNo];
    const total = Number(booth.totalVoters) || 0;
    const summary = cached?.summary || { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const completed = cached?.voters
      ? cached.voters.reduce((count, voter) => count + (voter.affinity ? 1 : 0), 0)
      : 0;

    return {
      boothNo,
      village: booth.village || '',
      mandal: booth.mandal || '',
      total,
      completed,
      pending: Math.max(total - completed, 0),
      completionPct: total ? Math.round((completed / total) * 100) : 0,
      loaded: !!cached,
      summary
    };
  });
}

function getDashboardBoothStatusClass(item) {
  if (!item.loaded) return 'dashboard-booth-syncing';
  if (item.completed >= item.total && item.total > 0) return 'dashboard-booth-complete';
  if (item.completionPct >= 75) return 'dashboard-booth-high';
  if (item.completionPct >= 50) return 'dashboard-booth-medium';
  if (item.completionPct >= 25) return 'dashboard-booth-low';
  return 'dashboard-booth-critical';
}

function groupBoothStatusesByVillage(boothStatuses) {
  const groups = new Map();

  boothStatuses.forEach(item => {
    const key = (item.village || 'Unassigned Village').trim() || 'Unassigned Village';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  });

  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([village, items]) => {
      const totalVoters = items.reduce((sum, item) => sum + item.total, 0);
      const completedVoters = items.reduce((sum, item) => sum + item.completed, 0);
      const completionPct = totalVoters ? Math.round((completedVoters / totalVoters) * 100) : 0;
      return {
        village,
        totalVoters,
        completedVoters,
        completionPct,
        items: items.sort((a, b) => a.boothNo - b.boothNo)
      };
    });
}

function renderDashboard() {
  if (!els.dashboardSection || !els.dashboardSummary || !els.dashboardBoothList || !els.dashboardScope || !els.dashboardRefreshState) {
    return;
  }

  if (!canViewDashboard()) {
    renderAppTabs();
    return;
  }

  renderDashboardFilters();

  const dashboardBooths = getDashboardScopedBooths();
  const boothStatuses = getAccessibleBoothStatusList(dashboardBooths);
  const loadedCount = boothStatuses.filter(item => item.loaded).length;
  const totalBooths = boothStatuses.length;
  const totalVoters = boothStatuses.reduce((sum, item) => sum + item.total, 0);
  const completedVoters = boothStatuses.reduce((sum, item) => sum + item.completed, 0);
  const completedBooths = boothStatuses.reduce((sum, item) => sum + (item.completed >= item.total && item.total > 0 ? 1 : 0), 0);
  const pendingVoters = Math.max(totalVoters - completedVoters, 0);
  const completionPct = totalVoters ? Math.round((completedVoters / totalVoters) * 100) : 0;

  const scopeParts = [`${state.user?.role || ''} scope: ${getDashboardScopeLabel()}`];
  if (state.dashboardSelectedMandal) scopeParts.push(`Mandal: ${state.dashboardSelectedMandal}`);
  if (state.dashboardSelectedVillage) scopeParts.push(`Village/Town: ${state.dashboardSelectedVillage}`);
  els.dashboardScope.textContent = scopeParts.join(' | ');
  els.dashboardRefreshState.textContent = loadedCount < totalBooths
    ? `Updating ${loadedCount}/${totalBooths} booths`
    : 'Up to date';

  els.dashboardSummary.innerHTML = `
    <div class="dashboard-metric">
      <strong>${totalVoters}</strong>
      <span>Total Voters</span>
    </div>
    <div class="dashboard-metric">
      <strong>${totalBooths}</strong>
      <span>Total Booths</span>
    </div>
    <div class="dashboard-metric">
      <strong>${completedBooths}</strong>
      <span>Total Booths Completed</span>
    </div>
    <div class="dashboard-metric">
      <strong>${completedVoters}</strong>
      <span>Total Voters Completed</span>
    </div>
    <div class="dashboard-metric">
      <strong>${pendingVoters}</strong>
      <span>Pending Voters</span>
    </div>
    <div class="dashboard-metric">
      <strong>${completionPct}%</strong>
      <span>Overall Completion %</span>
    </div>
  `;

  const villageGroups = groupBoothStatusesByVillage(boothStatuses);
  if (!villageGroups.length) {
    els.dashboardBoothList.innerHTML = '<div class="muted">No dashboard data available for the selected filters.</div>';
    renderAppTabs();
    return;
  }

  els.dashboardBoothList.innerHTML = villageGroups.map(group => `
    <section class="dashboard-village-group">
      <div class="dashboard-village-header">
        <div class="dashboard-village-title">
          <strong>${group.village}</strong>
          <span>${group.completedVoters}/${group.totalVoters} voters completed</span>
        </div>
        <div class="dashboard-village-completion">${group.completionPct}%</div>
      </div>
      <div class="dashboard-village-tiles">
        ${group.items.map(item => `
          <div class="dashboard-row ${getDashboardBoothStatusClass(item)}">
            <div class="dashboard-row-main">
              <strong>Booth ${item.boothNo}</strong>
              <span>${item.village || item.mandal}</span>
            </div>
            <div class="dashboard-row-stats">
              <span>${item.completed}/${item.total} voters</span>
              <span>${item.completionPct}%</span>
              <span>${item.loaded ? (item.completed >= item.total && item.total > 0 ? 'Completed' : 'In Progress') : 'Syncing'}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `).join('');
  renderAppTabs();
}

function queueDashboardRender() {
  if (state.pendingDashboardRenderTimer) {
    clearTimeout(state.pendingDashboardRenderTimer);
  }

  state.pendingDashboardRenderTimer = setTimeout(() => {
    state.pendingDashboardRenderTimer = null;
    renderDashboard();
  }, DASHBOARD_RENDER_DELAY_MS);
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

function updateSubmitButton() {
  els.submitAffinityBtn = byId('submitAffinityBtn') || els.submitAffinityBtn;
  if (!els.submitAffinityBtn) return;
  const hasBooth = !!state.selectedBooth;
  const hasVoters = !!state.boothData?.voters?.length;
  els.submitAffinityBtn.disabled = !(hasBooth && hasVoters && canEditAnyRows());
}

function affinityButton(code, current, slNo) {
  const active = current === code ? 'active' : '';
  const locked = isRowLocked(slNo) ? 'disabled' : '';
  return `
    <button class="affinity-btn affinity-${code} ${active}" data-sl="${slNo}" data-affinity="${code}" type="button" ${locked}>
      ${code}
    </button>
  `;
}

function getCurrentPageBounds() {
  const voters = state.boothData?.voters || [];
  const totalPages = Math.max(1, Math.ceil(voters.length / state.pageSize));
  if (state.currentPage > totalPages) state.currentPage = totalPages;

  const start = (state.currentPage - 1) * state.pageSize;
  const end = start + state.pageSize;
  return { start, end, totalPages };
}

function canEditSavedRows() {
  const role = String(state.user?.role || '').trim().toLowerCase();
  return role === 'sakthi kendra' || role === 'mandal president' || role === 'admin';
}

function canEditAnyRows() {
  const role = String(state.user?.role || '').trim().toLowerCase();
  return role !== 'manager';
}

function isRowSaved(slNo) {
  const voter = state.boothData?.voters?.find(v => v.slNo === slNo);
  return !!voter?.affinity;
}

function isRowLocked(slNo) {
  const voter = state.boothData?.voters?.find(v => v.slNo === slNo);
  if (!voter) return false;
  if (!canEditAnyRows()) return true;
  return !!voter.affinity && !canEditSavedRows() && !state.editingRows.has(slNo);
}

function renderVoters() {
  const voters = state.boothData?.voters || [];
  if (!voters.length) {
    els.votersContainer.innerHTML = state.selectedBoothAll
      ? '<div class="muted">Showing aggregate summary for all visible booths. Select a specific booth to enter affinity.</div>'
      : '<div class="muted">No voters found for this booth</div>';
    return;
  }

  const { start, end, totalPages } = getCurrentPageBounds();
  const pageRows = voters.slice(start, end);

  els.votersContainer.innerHTML = `
    <div class="voters-toolbar">
      <div class="voters-toolbar-group">
        <button id="prevPageBtn" type="button" ${state.currentPage === 1 ? 'disabled' : ''}>Previous</button>
        <button id="nextPageBtn" type="button" ${state.currentPage === totalPages ? 'disabled' : ''}>Next</button>
        <span><strong>Page ${state.currentPage} of ${totalPages}</strong></span>
        <span class="muted">Showing SL# ${start + 1} to ${Math.min(end, voters.length)}</span>
      </div>
      <button id="submitAffinityBtn" type="button">Submit</button>
    </div>

    ${pageRows.map(v => {
      const saved = isRowSaved(v.slNo);
      const locked = isRowLocked(v.slNo);
      const rowClass = saved ? ' voter-row-saved' : '';
      return `
        <div class="voter-row${rowClass}">
          <div class="sl-box">SL# ${v.slNo}</div>
          <div class="affinity-group">
            ${affinityButton('A', v.affinity, v.slNo)}
            ${affinityButton('B', v.affinity, v.slNo)}
            ${affinityButton('C', v.affinity, v.slNo)}
            ${affinityButton('D', v.affinity, v.slNo)}
            ${affinityButton('E', v.affinity, v.slNo)}
          </div>
        </div>
      `;
    }).join('')}
  `;

  els.votersContainer.querySelectorAll('.affinity-btn').forEach(btn => {
    btn.addEventListener('click', onAffinityClick);
  });

  const prevBtn = byId('prevPageBtn');
  const nextBtn = byId('nextPageBtn');
  els.submitAffinityBtn = byId('submitAffinityBtn');

  if (prevBtn) prevBtn.addEventListener('click', () => changePage(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => changePage(1));
  if (els.submitAffinityBtn) els.submitAffinityBtn.addEventListener('click', onSaveBooth);
  updateSubmitButton();
}

function buildBoothVoters(totalVoters) {
  const voters = [];
  for (let i = 1; i <= totalVoters; i++) {
    voters.push({ slNo: i, affinity: '' });
  }
  return voters;
}

function applySavedAffinity(savedRows, boothData = state.boothData, totalVoters = state.selectedBooth?.totalVoters || 0) {
  if (!boothData || !Array.isArray(boothData.voters)) return;

  const map = {};
  savedRows.forEach(r => {
    map[Number(r.slNo)] = String(r.affinity || '');
  });

  boothData.voters.forEach(v => {
    v.affinity = map[v.slNo] || '';
  });

  const calc = calculateSummary(boothData.voters, totalVoters);
  boothData.summary = calc.summary;
  boothData.completionPct = calc.completionPct;
}

function updateLocalSelection(slNo, affinity) {
  const voter = state.boothData.voters.find(v => v.slNo === slNo);
  if (!voter) return;

  voter.affinity = affinity;
  state.editingRows.delete(slNo);

  const calc = calculateSummary(state.boothData.voters, state.selectedBooth?.totalVoters || 0);
  state.boothData.summary = calc.summary;
  state.boothData.completionPct = calc.completionPct;
  setDraftForBooth(getCurrentBoothNumber(), state.boothData);
  queueDraftPersist();
  cacheCurrentBoothData();

  renderSummary();
  renderVoters();
  setAffinitySaveStatus('Saving changes...', 'warning');
  queueBackgroundSave();
}

function onAffinityClick(e) {
  if (!canEditAnyRows()) return;
  const btn = e.currentTarget;
  const slNo = Number(btn.dataset.sl);
  const affinity = btn.dataset.affinity;

  if (!slNo || !affinity) return;
  updateLocalSelection(slNo, affinity);
}

async function onSaveBooth() {
  if (!canEditAnyRows()) {
    setAffinitySaveStatus('View-only access. Saving is disabled for this role.', 'warning');
    return false;
  }

  if (!state.selectedBooth || !state.boothData?.voters?.length) {
    setAffinitySaveStatus('Select a booth before submitting affinity.', 'error');
    return false;
  }

  if (state.pendingSaveTimer) {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = null;
  }

  try {
    showLoading(true);
    return await saveCurrentBoothSilently();
  } finally {
    showLoading(false);
  }
}

function buildSavePayload(boothNo, boothData) {
  return {
    action: 'saveBoothAffinities',
    booth: boothNo,
    voters: boothData.voters
  };
}

function getBoothDataForSave(boothNo, boothDataOverride = null) {
  const selected = getBoothConfig(boothNo);
  if (!selected) return null;

  let boothData = boothDataOverride
    ? cloneBoothData(boothDataOverride)
    : boothNo === getCurrentBoothNumber() && state.boothData
      ? cloneBoothData(state.boothData)
      : state.pageCache[boothNo]
        ? cloneBoothData(state.pageCache[boothNo])
        : createBoothData(selected.totalVoters);

  applyDraftToBoothData(boothData, boothNo, selected.totalVoters || 0);
  return boothData;
}

function finalizeSaveSuccess(boothNo, boothData, result) {
  boothData.summary = result.summary || boothData.summary;
  boothData.completionPct = result.completionPct || boothData.completionPct;
  state.pageCache[boothNo] = cloneBoothData(boothData);
  clearDraftForBooth(boothNo);
  queueDraftPersist();
  queueDashboardRender();

  if (boothNo === getCurrentBoothNumber() && state.boothData) {
    state.boothData.summary = boothData.summary;
    state.boothData.completionPct = boothData.completionPct;
    cacheCurrentBoothData();
    renderSummary();
  }
}

function scheduleRetrySync() {
  if (state.retrySyncTimer) {
    clearTimeout(state.retrySyncTimer);
  }

  if (!Object.keys(state.localDrafts || {}).length) return;

  state.retrySyncTimer = setTimeout(() => {
    state.retrySyncTimer = null;
    syncPendingDrafts();
  }, RETRY_SYNC_DELAY_MS);
}

async function saveCurrentBoothSilently(options = {}) {
  const boothNo = Number(options.boothNo || getCurrentBoothNumber());
  if (!boothNo) return true;

  const boothData = getBoothDataForSave(boothNo, options.boothData || null);
  if (!boothData) return true;

  try {
    if (!options.silentStatus && boothNo === getCurrentBoothNumber()) {
      setAffinitySaveStatus('Saving changes...', 'warning');
    }

    const result = await postApi(buildSavePayload(boothNo, boothData), {
      keepalive: !!options.keepalive
    });

    if (!result.ok) {
      console.error(result.message || 'Background save failed');
      if (!options.silentStatus && boothNo === getCurrentBoothNumber()) {
        setAffinitySaveStatus('Save failed. Changes kept on device and will retry.', 'error');
      }
      scheduleRetrySync();
      return false;
    }

    finalizeSaveSuccess(boothNo, boothData, result);
    if (!options.silentStatus && boothNo === getCurrentBoothNumber()) {
      setAffinitySaveStatus('All changes saved.', 'success');
    }
    return true;
  } catch (err) {
    console.error(err.message || 'Background save failed');
    if (!options.silentStatus && boothNo === getCurrentBoothNumber()) {
      setAffinitySaveStatus('Save failed. Changes kept on device and will retry.', 'error');
    }
    scheduleRetrySync();
    return false;
  }
}

function queueBackgroundSave() {
  if (state.pendingSaveTimer) {
    clearTimeout(state.pendingSaveTimer);
  }

  state.pendingSaveTimer = setTimeout(() => {
    saveCurrentBoothSilently();
    state.pendingSaveTimer = null;
  }, 400);
}

async function syncPendingDrafts() {
  if (state.syncInProgress || !state.user) return;

  const draftBooths = Object.keys(state.localDrafts || {})
    .map(Number)
    .filter(boothNo => !!getBoothConfig(boothNo));

  if (!draftBooths.length) return;

  state.syncInProgress = true;

  try {
    for (const boothNo of draftBooths) {
      await saveCurrentBoothSilently({
        boothNo,
        silentStatus: boothNo !== getCurrentBoothNumber()
      });
    }
  } finally {
    state.syncInProgress = false;
  }
}

function flushPendingBoothData() {
  const boothNo = getCurrentBoothNumber();
  if (!boothNo || !getDraftForBooth(boothNo)) return;

  persistDraftsNow();

  const boothData = getBoothDataForSave(boothNo);
  if (!boothData) return;

  const payload = buildSavePayload(boothNo, boothData);
  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
      navigator.sendBeacon(API_URL, blob);
      return;
    }
  } catch (err) {
    console.error('sendBeacon failed:', err.message || err);
  }

  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    keepalive: true
  }).catch(() => {});
}

async function changePage(direction) {
  if (!state.boothData?.voters?.length) return;

  const totalPages = Math.max(1, Math.ceil(state.boothData.voters.length / state.pageSize));
  const newPage = state.currentPage + direction;

  if (newPage < 1 || newPage > totalPages) return;

  state.currentPage = newPage;
  renderVoters();
}

async function loadSavedAffinity(booth) {
  const result = await callApi({
    action: 'getSavedAffinity',
    booth
  });

  if (!result.ok) {
    throw new Error(result.message || 'Failed to load saved affinity');
  }

  return result.saved || [];
}

function fetchBoothData(booth) {
  const boothNo = Number(booth);
  const selected = getBoothConfig(boothNo);
  if (!selected) {
    return Promise.reject(new Error('Booth not found'));
  }

  if (state.pageCache[boothNo]) {
    const cached = cloneBoothData(state.pageCache[boothNo]);
    applyDraftToBoothData(cached, boothNo, selected.totalVoters || 0);
    return Promise.resolve(cached);
  }

  if (state.pendingBoothLoads[boothNo]) {
    return state.pendingBoothLoads[boothNo].then(boothData => {
      const cloned = cloneBoothData(boothData);
      applyDraftToBoothData(cloned, boothNo, selected.totalVoters || 0);
      return cloned;
    });
  }

  const request = (async () => {
    const boothData = createBoothData(selected.totalVoters);
    const savedRows = await loadSavedAffinity(boothNo);
    applySavedAffinity(savedRows, boothData, selected.totalVoters || 0);
    applyDraftToBoothData(boothData, boothNo, selected.totalVoters || 0);
    state.pageCache[boothNo] = cloneBoothData(boothData);
    queueDashboardRender();
    return boothData;
  })();

  state.pendingBoothLoads[boothNo] = request;

  return request
    .then(cloneBoothData)
    .finally(() => {
      delete state.pendingBoothLoads[boothNo];
    });
}

function warmBoothCache() {
  if (state.prefetchStarted || !state.booths.length) return;
  state.prefetchStarted = true;

  const boothNumbers = state.booths.map(b => Number(b.booth));
  const totalBooths = boothNumbers.length;
  const concurrency = totalBooths > 60
    ? 2
    : totalBooths > 24
      ? 3
      : Math.min(4, totalBooths);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < boothNumbers.length) {
      const boothNo = boothNumbers[nextIndex++];
      if (state.pageCache[boothNo]) continue;
      try {
        await fetchBoothData(boothNo);
      } catch (err) {
        console.error(`Warm cache failed for booth ${boothNo}:`, err.message || err);
      }
    }
  };

  const startWorkers = () => {
    for (let i = 0; i < concurrency; i++) {
      worker();
    }
  };

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(startWorkers, { timeout: 1200 });
  } else {
    window.setTimeout(startWorkers, 250);
  }
}

async function loadBoothData(booth) {
  const selected = getBoothConfig(booth);
  if (!selected) throw new Error('Booth not found');
  const loadId = ++state.activeBoothLoadId;

  state.selectedBoothAll = false;
  state.selectedBooth = selected;
  state.currentPage = 1;
  state.editingRows.clear();
  if (state.pendingSaveTimer) {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = null;
  }

  renderBoothDetails();
  setAffinitySaveStatus('');
  state.boothData = null;
  renderSummary();
  els.votersContainer.innerHTML = '<div class="muted">Loading booth data...</div>';
  updateSubmitButton();

  const boothData = await fetchBoothData(booth);
  if (loadId !== state.activeBoothLoadId || Number(state.selectedBooth?.booth) !== Number(booth)) {
    return;
  }

  state.boothData = boothData;
  renderSummary();
  renderVoters();
  updateSubmitButton();
  setAffinitySaveStatus(
    getDraftForBooth(Number(booth))
      ? 'Recovered unsaved local changes. Sync pending.'
      : '',
    getDraftForBooth(Number(booth)) ? 'warning' : 'muted'
  );
  queueDashboardRender();
}

async function onBoothChange() {
  const rawValue = els.boothSelect.value;
  if (!rawValue) {
    state.activeBoothLoadId++;
    state.selectedBoothAll = false;
    state.selectedBooth = null;
    state.boothData = null;
    renderBoothDetails();
    renderSummary();
    renderVoters();
    updateSubmitButton();
    setAffinitySaveStatus('');
    return;
  }

  if (rawValue === '__all__') {
    state.activeBoothLoadId++;
    state.selectedBoothAll = true;
    state.selectedBooth = null;
    state.currentPage = 1;
    state.editingRows.clear();
    if (state.pendingSaveTimer) {
      clearTimeout(state.pendingSaveTimer);
      state.pendingSaveTimer = null;
    }
    state.boothData = buildAggregateBoothData();
    renderBoothDetails();
    renderSummary();
    renderVoters();
    updateSubmitButton();
    setAffinitySaveStatus('Showing aggregate data for all visible booths. Select a specific booth to enter affinity.');
    return;
  }

  const booth = Number(rawValue);

  let loadingTimer = null;

  try {
    if (!state.pageCache[booth]) {
      loadingTimer = setTimeout(() => {
        showLoading(true);
      }, 120);
    }
    await loadBoothData(booth);
  } catch (err) {
    alert(err.message || 'Unable to load booth');
  } finally {
    if (loadingTimer) clearTimeout(loadingTimer);
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

function getUserByPhone(phone) {
  if (!state.staticData?.users) return null;
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  return state.staticData.users.find(u => {
    const userPhone = String(u.phone || '').replace(/\D/g, '').slice(-10);
    return userPhone === cleanPhone;
  }) || null;
}

function getBoothsForUser(user) {
  if (!state.staticData || !state.staticData.booths) return [];

  if (user.booths === 'all') {
    return [...state.staticData.booths].sort((a, b) => a.booth - b.booth);
  }

  const allowed = Array.isArray(user.booths)
    ? user.booths.map(x => Number(x))
    : [];

  return state.staticData.booths
    .filter(b => allowed.includes(Number(b.booth)))
    .sort((a, b) => a.booth - b.booth);
}

function applyVisibleBoothScope() {
  const showFilter = requiresMandalSelection();
  const scopedBooths = state.selectedMandal === '__all__'
    ? [...state.allBooths]
    : state.selectedMandal
      ? state.allBooths.filter(booth => String(booth.mandal || '').trim() === state.selectedMandal)
      : showFilter
        ? []
        : [...state.allBooths];

  state.booths = scopedBooths.sort((a, b) => a.booth - b.booth);
  state.boothMap = new Map(state.booths.map(booth => [Number(booth.booth), booth]));
  renderMandalDropdown();
  renderBoothDropdown();

  const currentBoothNo = Number(state.selectedBooth?.booth) || 0;
  if (currentBoothNo && state.boothMap.has(currentBoothNo)) {
    state.selectedBoothAll = false;
    state.selectedBooth = state.boothMap.get(currentBoothNo);
    if (els.boothSelect) els.boothSelect.value = String(currentBoothNo);
  } else if (state.selectedBoothAll && state.booths.length) {
    if (els.boothSelect) els.boothSelect.value = '__all__';
    state.boothData = buildAggregateBoothData();
    renderBoothDetails();
    renderSummary();
    renderVoters();
    updateSubmitButton();
    setAffinitySaveStatus('Showing aggregate data for all visible booths. Select a specific booth to enter affinity.');
  } else {
    state.activeBoothLoadId++;
    state.selectedBoothAll = false;
    state.selectedBooth = null;
    state.boothData = null;
    if (els.boothSelect) els.boothSelect.value = '';
    renderBoothDetails();
    renderSummary();
    renderVoters();
    updateSubmitButton();
    setAffinitySaveStatus(showFilter ? 'Select a mandal to load booths.' : '');
  }

  renderDashboard();
  renderDataRefreshLog();
  renderAppTabs();
}

function refreshAccessibleDataForUser(user) {
  state.user = {
    phone: user.phone,
    name: user.name,
    role: user.role,
    mandal: user.mandal
  };
  state.allBooths = getBoothsForUser(user);
  state.allBoothMap = new Map(state.allBooths.map(b => [Number(b.booth), b]));
  state.pageCache = Object.fromEntries(
    Object.entries(state.pageCache).filter(([boothNo]) => state.allBoothMap.has(Number(boothNo)))
  );
  state.pendingBoothLoads = {};
  state.prefetchStarted = false;
  const availableMandals = getAvailableMandals();
  if (!requiresMandalSelection()) {
    state.selectedMandal = '';
    state.selectedBoothAll = false;
  } else if (state.selectedMandal && state.selectedMandal !== '__all__' && !availableMandals.includes(state.selectedMandal)) {
    state.selectedMandal = '';
  }
  syncDashboardFilterState();

  renderUser();
  applyVisibleBoothScope();
  warmBoothCache();
}

async function ensureInitialBoothSelection() {
  if (state.selectedBooth || !state.booths.length || !els.boothSelect) return;

  const firstBooth = Number(state.booths[0]?.booth);
  if (!firstBooth) return;

  els.boothSelect.value = String(firstBooth);
  try {
    showLoading(true);
    await loadBoothData(firstBooth);
  } finally {
    showLoading(false);
  }
}

async function onMandalChange() {
  if (!els.mandalSelect) return;
  state.selectedMandal = els.mandalSelect.value || '';
  state.prefetchStarted = false;
  applyVisibleBoothScope();
  await ensureInitialBoothSelection();
}

function onDashboardMandalChange() {
  if (!els.dashboardMandalSelect) return;
  state.dashboardSelectedMandal = els.dashboardMandalSelect.value || '';
  syncDashboardFilterState();
  renderDashboard();
}

function onDashboardVillageChange() {
  if (!els.dashboardVillageSelect) return;
  state.dashboardSelectedVillage = els.dashboardVillageSelect.value || '';
  renderDashboard();
}

async function refreshStaticDataInBackground(options = {}) {
  const previousData = state.staticData
    ? JSON.parse(JSON.stringify(state.staticData))
    : null;
  const logChanges = !!options.logChanges;

  try {
    const refreshedData = await loadStaticData({ forceRefresh: true });
    if (!state.user) return;

    const refreshedUser = getUserByPhone(state.user.phone);
    if (!refreshedUser) {
      console.warn(`Static refresh: user ${state.user.phone} no longer exists in static data.`);
      if (logChanges && canUseDataRefresh()) {
        state.dataRefreshLogs.unshift({
          title: 'Manual Refresh',
          timestamp: formatTimestamp(),
          summary: 'Refresh completed, but the current admin user was not found in the refreshed source.',
          lines: ['Current user no longer exists in the refreshed static data.']
        });
        state.dataRefreshLogs = state.dataRefreshLogs.slice(0, 12);
        renderDataRefreshLog();
      }
      return;
    }

    refreshAccessibleDataForUser(refreshedUser);
    if (logChanges && canUseDataRefresh() && previousData) {
      const diff = diffStaticData(previousData, refreshedData);
      state.dataRefreshLogs.unshift({
        title: 'Manual Refresh',
        timestamp: formatTimestamp(),
        summary: diff.summary,
        lines: diff.lines
      });
      state.dataRefreshLogs = state.dataRefreshLogs.slice(0, 12);
      renderDataRefreshLog();
    }
  } catch (err) {
    console.error('Static data refresh failed:', err.message || err);
    if (logChanges && canUseDataRefresh()) {
      state.dataRefreshLogs.unshift({
        title: 'Manual Refresh Failed',
        timestamp: formatTimestamp(),
        summary: err.message || 'Static data refresh failed.',
        lines: ['No changes were applied to the current session.']
      });
      state.dataRefreshLogs = state.dataRefreshLogs.slice(0, 12);
      renderDataRefreshLog();
    }
  }
}

async function onManualDataRefresh() {
  if (!canUseDataRefresh() || state.dataRefreshInProgress) return;
  state.dataRefreshInProgress = true;
  renderDataRefreshLog();

  try {
    await refreshStaticDataInBackground({ logChanges: true });
  } finally {
    state.dataRefreshInProgress = false;
    renderDataRefreshLog();
    renderAppTabs();
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
  state.localDrafts = readLocalDrafts();
  state.pageCache = {};
  state.pendingBoothLoads = {};
  state.prefetchStarted = false;

  els.loginSection.style.display = 'none';
  els.appSection.style.display = 'block';

  refreshAccessibleDataForUser(user);
  await ensureInitialBoothSelection();
  syncPendingDrafts();
}

function logout() {
  persistDraftsNow();
  if (state.pendingSaveTimer) {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = null;
  }
  if (state.retrySyncTimer) {
    clearTimeout(state.retrySyncTimer);
    state.retrySyncTimer = null;
  }
  if (state.pendingDraftPersistTimer) {
    clearTimeout(state.pendingDraftPersistTimer);
    state.pendingDraftPersistTimer = null;
  }
  state.user = null;
  state.allBooths = [];
  state.allBoothMap = new Map();
  state.booths = [];
  state.boothMap = new Map();
  state.selectedMandal = '';
  state.selectedBoothAll = false;
  state.dashboardSelectedMandal = '';
  state.dashboardSelectedVillage = '';
  state.selectedBooth = null;
  state.boothData = null;
  state.pageCache = {};
  state.pendingBoothLoads = {};
  state.prefetchStarted = false;
  state.localDrafts = {};
  state.syncInProgress = false;
  state.activeView = 'entry';
  state.dataRefreshInProgress = false;

  els.phone.value = '';
  els.password.value = '';
  setLoginError('');
  setAffinitySaveStatus('');

  els.loginSection.style.display = 'block';
  els.appSection.style.display = 'none';
  if (els.dashboardSection) els.dashboardSection.style.display = 'none';
  if (els.dataRefreshSection) els.dataRefreshSection.style.display = 'none';
  updateSubmitButton();
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
  els.dashboardSection = byId('dashboardSection');
  els.dataRefreshSection = byId('dataRefreshSection');
  els.entrySection = byId('entrySection');
  els.appTabs = byId('appTabs');
  els.entryTabBtn = byId('entryTabBtn');
  els.dashboardTabBtn = byId('dashboardTabBtn');
  els.dataRefreshTabBtn = byId('dataRefreshTabBtn');
  els.runDataRefreshBtn = byId('runDataRefreshBtn');
  els.dataRefreshStatus = byId('dataRefreshStatus');
  els.dataRefreshLog = byId('dataRefreshLog');
  els.dashboardScope = byId('dashboardScope');
  els.dashboardRefreshState = byId('dashboardRefreshState');
  els.dashboardSummary = byId('dashboardSummary');
  els.dashboardBoothList = byId('dashboardBoothList');
  els.dashboardFilters = byId('dashboardFilters');
  els.dashboardMandalSelect = byId('dashboardMandalSelect');
  els.dashboardVillageSelect = byId('dashboardVillageSelect');
  els.mandalFilterGroup = byId('mandalFilterGroup');
  els.mandalSelect = byId('mandalSelect');
  els.boothSelect = byId('boothSelect');
  els.boothMetaSummary = byId('boothMetaSummary');
  els.boothDetails = byId('boothDetails');
  els.votersContainer = byId('votersContainer');
  els.affinitySaveStatus = byId('affinitySaveStatus');
  els.summaryA = byId('summaryA');
  els.summaryB = byId('summaryB');
  els.summaryC = byId('summaryC');
  els.summaryD = byId('summaryD');
  els.summaryE = byId('summaryE');
  els.completionPct = byId('completionPct');
  els.logoutBtn = byId('logoutBtn');
  els.loading = byId('loading');

  await loadStaticData();
  if (!state.staticRefreshTimer) {
    state.staticRefreshTimer = window.setInterval(refreshStaticDataInBackground, STATIC_REFRESH_INTERVAL_MS);
  }

  els.loginForm.addEventListener('submit', onLoginSubmit);
  if (els.mandalSelect) els.mandalSelect.addEventListener('change', onMandalChange);
  if (els.dashboardMandalSelect) els.dashboardMandalSelect.addEventListener('change', onDashboardMandalChange);
  if (els.dashboardVillageSelect) els.dashboardVillageSelect.addEventListener('change', onDashboardVillageChange);
  if (els.boothSelect) els.boothSelect.addEventListener('change', onBoothChange);
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', logout);
  if (els.entryTabBtn) els.entryTabBtn.addEventListener('click', () => setActiveView('entry'));
  if (els.dashboardTabBtn) els.dashboardTabBtn.addEventListener('click', () => setActiveView('dashboard'));
  if (els.dataRefreshTabBtn) els.dataRefreshTabBtn.addEventListener('click', () => setActiveView('data-refresh'));
  if (els.runDataRefreshBtn) els.runDataRefreshBtn.addEventListener('click', onManualDataRefresh);
  window.addEventListener('online', syncPendingDrafts);
  window.addEventListener('pagehide', flushPendingBoothData);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingBoothData();
    }
  });

  renderBoothDetails();
  renderSummary();
  renderVoters();
  renderDashboard();
  renderDataRefreshLog();
  renderAppTabs();
  updateSubmitButton();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    alert(err.message || 'App failed to load');
  });
});

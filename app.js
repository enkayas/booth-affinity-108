const API_URL = 'https://script.google.com/macros/s/AKfycbxPKgX704pUFmDWtVnlJMEraV1dKohtw4zF5Cwj7E-I0ffvP9D0jUwLavtt8HZcEGo01g/exec';
const DRAFT_STORAGE_KEY = 'booth_affinity_drafts_v1';
const DRAFT_PERSIST_DELAY_MS = 120;
const RETRY_SYNC_DELAY_MS = 5000;
const DASHBOARD_RENDER_DELAY_MS = 120;
const DASHBOARD_STATUS_REFRESH_INTERVAL_MS = 45 * 1000;
const STATIC_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const BOOTH_PREFETCH_DELAY_MS = 1500;
const DASHBOARD_VISIBLE_ROLES = new Set(['sakthi kendra', 'mandal president', 'manager', 'admin']);

const state = {
  staticData: null,
  user: null,
  allBooths: [],
  allBoothMap: new Map(),
  booths: [],
  boothMap: new Map(),
  selectedMandal: '',
  selectedVillage: '',
  selectedBoothAll: false,
  dashboardSelectedMandal: '',
  dashboardSelectedVillage: '',
  dashboardSelectedStatus: '',
  dashboardSelectedBooth: null,
  dashboardDetailLoading: false,
  selectedBooth: null,
  boothData: null,
  currentPage: 1,
  pageSize: 50,
  pageCache: {},
  pendingBoothLoads: {},
  prefetchStarted: false,
  pendingPrefetchTimer: null,
  prefetchToken: 0,
  localDrafts: {},
  editingRows: new Set(),
  pendingVotersFilter: false,
  pendingSaveTimer: null,
  pendingDraftPersistTimer: null,
  retrySyncTimer: null,
  syncInProgress: false,
  pendingDashboardRenderTimer: null,
  dashboardStatusRefreshInProgress: false,
  lastDashboardStatusRefreshAt: 0,
  dashboardRefreshTimer: null,
  activeBoothLoadId: 0,
  staticRefreshTimer: null,
  activeView: 'entry',
  dataRefreshLogs: [],
  dataRefreshInProgress: false,
  vlBoothData: null,         // rows for the currently loaded booth
  vlLoadedBooth: null,       // booth number currently loaded
  vlFiltersPopulated: false, // mandal/booth dropdowns have been built
  vlPage: 1,
  vlFiltered: [],
  hmBoothNo: null,           // heatmap: currently loaded booth
  hmVoters: [],              // heatmap: [{slNo, affinity, relocated, voted}]
  hmFiltersPopulated: false, // heatmap: booth dropdowns built
  hmSaving: false,           // heatmap: save in progress
  hmActiveView: 'heatmap',   // 'heatmap' | 'progress'
  hmProgSubView: 'nda',      // 'nda' | 'opp'
  hmProgActiveMandal: null,  // currently selected mandal tab
  hmProgLoading: false,
  hmProgAutoRefreshed: false, // auto-fetch affinity data once on first Progress view open
  hmVotedBooths: {},         // boothNo → votedCount, only from heatmap clicks or explicit refresh
  hmVotedSlNos:  {},         // boothNo → [slNo, ...] of voters who have voted (from refresh)
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

function normalizeBoothRating(rating) {
  const normalized = String(rating || '').trim().toUpperCase();
  return /^[A-F]$/.test(normalized) ? normalized : '';
}

function getBoothRatingClass(rating) {
  const normalized = normalizeBoothRating(rating);
  return normalized ? `booth-rating-${normalized.toLowerCase()}` : 'booth-rating-na';
}

function renderBoothRatingBadge(rating, options = {}) {
  const normalized = normalizeBoothRating(rating);
  const label = normalized || options.fallbackLabel || 'NA';
  const compactClass = options.compact ? ' booth-rating-badge-compact' : '';
  return `<span class="booth-rating-badge ${getBoothRatingClass(normalized)}${compactClass}">${label}</span>`;
}

function canViewRelocatedFlag() {
  const role = normalizeRole(state.user?.role);
  return role === 'manager' || role === 'admin';
}

function canViewVotedFlag() {
  const role = normalizeRole(state.user?.role);
  return role === 'manager' || role === 'admin';
}

function canEditRelocatedFlag() {
  return canViewRelocatedFlag();
}

function canEditVotedFlag() {
  return canViewVotedFlag();
}

function canSubmitBoothChanges() {
  return canEditAnyRows() || canEditRelocatedFlag();
}

function readTruthyFlag(value) {
  if (value === true) return true;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}

function canViewDashboard() {
  return DASHBOARD_VISIBLE_ROLES.has(normalizeRole(state.user?.role));
}

function canUseDataRefresh() {
  return normalizeRole(state.user?.role) === 'admin';
}

function canViewVoterList() {
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
    params.set('_t', Date.now()); // prevent Apps Script GET cache

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
  els.userName.textContent = mandal
    ? `Voter Insights - வாக்காளர் நுண்ணறிவு | ${mandal}`
    : 'Voter Insights - வாக்காளர் நுண்ணறிவு';
  els.userMeta.textContent = `${state.user.name || ''} | ${state.user.role || ''}`;
}

function renderBoothDropdown() {
  els.boothSelect.innerHTML = '';
  const canUseAllOptions = requiresMandalSelection();

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Booth / வாக்குச் சாவடி';
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

function getEntryVillageOptions() {
  if (!state.selectedMandal) return [];

  const scopedByMandal = state.selectedMandal === '__all__'
    ? (state.allBooths || [])
    : (state.allBooths || []).filter(booth => String(booth.mandal || '').trim() === state.selectedMandal);

  return Array.from(new Set(
    scopedByMandal
      .map(booth => String(booth.village || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
}

function syncEntryFilterState() {
  const villages = getEntryVillageOptions();
  if (state.selectedVillage && state.selectedVillage !== '__all__' && !villages.includes(state.selectedVillage)) {
    state.selectedVillage = '';
  }
}

function getDashboardAvailableMandals() {
  return getAvailableMandals();
}

function getDashboardVillageOptions() {
  if (!state.dashboardSelectedMandal) return [];

  const scopedByMandal = state.dashboardSelectedMandal && state.dashboardSelectedMandal !== '__all__'
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
  if (state.dashboardSelectedMandal && state.dashboardSelectedMandal !== '__all__' && !mandals.includes(state.dashboardSelectedMandal)) {
    // Mandal no longer available (e.g. after data refresh) — fall back to All instead of clearing
    state.dashboardSelectedMandal = '__all__';
  }

  const villages = getDashboardVillageOptions();
  if (state.dashboardSelectedVillage && !villages.includes(state.dashboardSelectedVillage)) {
    state.dashboardSelectedVillage = '';
  }
}

function getDashboardScopedBooths() {
  if (!state.dashboardSelectedMandal) return [];

  let scopedBooths = [...(state.allBooths || [])];

  if (state.dashboardSelectedMandal && state.dashboardSelectedMandal !== '__all__') {
    scopedBooths = scopedBooths.filter(
      booth => String(booth.mandal || '').trim() === state.dashboardSelectedMandal
    );
  }

  if (state.dashboardSelectedVillage && state.dashboardSelectedVillage !== '__all__') {
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
  defaultMandalOpt.textContent = 'Mandal / மண்டல்';
  els.dashboardMandalSelect.appendChild(defaultMandalOpt);

  const allMandalOpt = document.createElement('option');
  allMandalOpt.value = '__all__';
  allMandalOpt.textContent = 'All';
  els.dashboardMandalSelect.appendChild(allMandalOpt);

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
  defaultVillageOpt.textContent = 'Panchyat / கிராமம் / பஞ்சாயத்து';
  els.dashboardVillageSelect.appendChild(defaultVillageOpt);

  const allVillageOpt = document.createElement('option');
  allVillageOpt.value = '__all__';
  allVillageOpt.textContent = 'All';
  els.dashboardVillageSelect.appendChild(allVillageOpt);

  villages.forEach(village => {
    const opt = document.createElement('option');
    opt.value = village;
    opt.textContent = village;
    els.dashboardVillageSelect.appendChild(opt);
  });
  els.dashboardVillageSelect.value = state.dashboardSelectedVillage || '';

  if (els.dashboardStatusSelect) {
    els.dashboardStatusSelect.value = state.dashboardSelectedStatus || '';
  }
}

function renderMandalDropdown() {
  if (!els.mandalFilterGroup || !els.mandalSelect) return;

  const showFilter = requiresMandalSelection();
  els.mandalFilterGroup.style.display = showFilter ? 'block' : 'none';

  if (!showFilter) {
    els.mandalSelect.innerHTML = '<option value="">Mandal / மண்டல்</option>';
    return;
  }

  const mandals = getAvailableMandals();
  els.mandalSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Mandal / மண்டல்';
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

function renderVillageDropdown() {
  if (!els.villageFilterGroup || !els.villageSelect) return;

  const showFilter = requiresMandalSelection();
  els.villageFilterGroup.style.display = showFilter ? 'block' : 'none';

  if (!showFilter) {
    els.villageSelect.innerHTML = '<option value="">Panchyat / கிராமம் / பஞ்சாயத்து</option>';
    return;
  }

  const villages = getEntryVillageOptions();
  els.villageSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Panchyat / கிராமம் / பஞ்சாயத்து';
  els.villageSelect.appendChild(defaultOpt);

  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = 'All';
  els.villageSelect.appendChild(allOpt);

  villages.forEach(village => {
    const opt = document.createElement('option');
    opt.value = village;
    opt.textContent = village;
    els.villageSelect.appendChild(opt);
  });

  els.villageSelect.value = state.selectedVillage || '';
}

function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return String(phone || '');
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

function formatNumberIndian(value) {
  const num = Number(value) || 0;
  return num.toLocaleString('en-IN');
}

function hasScopedEntryAggregateView() {
  return requiresMandalSelection() && !!state.selectedMandal && !state.selectedBooth && !state.selectedBoothAll;
}

function isEntryAggregateViewActive() {
  return state.selectedBoothAll || hasScopedEntryAggregateView();
}

function getEntryAggregateStatusMessage() {
  return state.selectedBoothAll
    ? 'Showing aggregate data for all visible booths. Select a specific booth to enter affinity.'
    : 'Showing aggregate data for the selected mandal. Select a specific booth to enter affinity.';
}

function renderEntryAggregateView() {
  if (!isEntryAggregateViewActive()) return false;
  state.boothData = buildAggregateBoothData();
  renderBoothDetails();
  renderSummary();
  renderVoters();
  updateSubmitButton();
  setAffinitySaveStatus(getEntryAggregateStatusMessage());
  return true;
}

function renderBoothMetaSummary() {
  const b = state.selectedBooth;
  if (!els.boothMetaSummary) return;

  if (isEntryAggregateViewActive()) {
    const totalVoters = state.booths.reduce((sum, booth) => sum + (Number(booth.totalVoters) || 0), 0);
    const mandalLabel = state.selectedMandal === '__all__' ? 'ALL' : (state.selectedMandal || 'All Mandals');
    els.boothMetaSummary.innerHTML = `
      <div class="mini-detail-row">
        <div><strong>Booth # / வாக்குச் சாவடி எண்</strong><span>All Booths</span></div>
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
      <div><strong>Booth # / வாக்குச் சாவடி எண்</strong><span>${b.booth}</span></div>
      <div><strong>Mandal</strong><span>${b.mandal || ''}</span></div>
      <div><strong>Total Voters</strong><span>${b.totalVoters || 0}</span></div>
      <div><strong>Booth Rating</strong>${renderBoothRatingBadge(b.boothRating)}</div>
    </div>
  `;
}

function getBoothContacts(booth) {
  if (!state.staticData?.users || !booth) return [];

  const boothNo = Number(booth);
  const roleOrder = ['Mandal President', 'Sakthi Kendra', 'BLA2', 'Booth President'];

  return state.staticData.users
    .filter(u => {
      const ub = Array.isArray(u.booths) ? u.booths : (u.booths != null ? [u.booths] : []);
      return ub.map(Number).includes(boothNo) && roleOrder.includes(u.role);
    })
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
  if (isEntryAggregateViewActive()) {
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
          <div><strong>Selection Scope</strong><span>${state.selectedBoothAll ? 'All Booths' : 'Selected Mandal'} (${boothCount})</span></div>
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
        <div><strong>Booth Rating</strong>${renderBoothRatingBadge(b.boothRating)}</div>
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

  return { summary, completionPct, filled };
}

function getCompletedCountFromCache(cached) {
  if (!cached) return 0;

  const completedCount = Number(cached.completedCount || 0);
  if (completedCount > 0) return completedCount;

  const summary = cached.summary || { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const fromSummary = Number(summary.A || 0)
    + Number(summary.B || 0)
    + Number(summary.C || 0)
    + Number(summary.D || 0)
    + Number(summary.E || 0);
  if (fromSummary > 0) return fromSummary;

  if (Array.isArray(cached.voters)) {
    return cached.voters.reduce((count, voter) => count + (voter.affinity ? 1 : 0), 0);
  }

  return 0;
}

function createBoothData(totalVoters) {
  return {
    voters: buildBoothVoters(Number(totalVoters) || 0),
    summary: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    completionPct: 0,
    completedCount: 0,
    relocatedCount: 0,
    votedCount: 0,
    updatedAt: Date.now()
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
      ? boothData.voters.map(v => ({
          slNo: v.slNo,
          affinity: v.affinity || '',
          relocated: !!v.relocated,
          voted: !!v.voted
        }))
      : [],
    summary: {
      A: boothData.summary?.A || 0,
      B: boothData.summary?.B || 0,
      C: boothData.summary?.C || 0,
      D: boothData.summary?.D || 0,
      E: boothData.summary?.E || 0
    },
    completionPct: boothData.completionPct || 0,
    completedCount: Number(boothData.completedCount || 0),
    relocatedCount: Number(boothData.relocatedCount || 0),
    votedCount: Number(boothData.votedCount || 0),
    updatedAt: Number(boothData.updatedAt || Date.now())
  };
}

function buildDraftFromBoothData(boothData) {
  if (!boothData?.voters?.length) return null;

  const voters = boothData.voters
    .filter(v => v.affinity || v.relocated || v.voted)
    .map(v => ({
      slNo: v.slNo,
      affinity: v.affinity,
      relocated: !!v.relocated,
      voted: !!v.voted
    }));

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
  if (isEntryAggregateViewActive() && state.boothMap.has(boothNo)) {
    renderEntryAggregateView();
  }
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

function startDashboardRefreshTimer() {
  stopDashboardRefreshTimer();
  state.dashboardRefreshTimer = window.setInterval(() => {
    if (state.activeView === 'dashboard') {
      refreshDashboardStatusesInBackground();
    }
  }, DASHBOARD_STATUS_REFRESH_INTERVAL_MS);
}

function stopDashboardRefreshTimer() {
  if (state.dashboardRefreshTimer) {
    clearInterval(state.dashboardRefreshTimer);
    state.dashboardRefreshTimer = null;
  }
}

function setActiveView(view) {
  const canUseDashboard = canViewDashboard();
  const canRefreshData = canUseDataRefresh();
  if (view === 'dashboard' && canUseDashboard) {
    if (!state.dashboardSelectedMandal) {
      state.dashboardSelectedMandal = '__all__';
    }
    state.activeView = 'dashboard';
    state.lastDashboardStatusRefreshAt = 0;
    startDashboardRefreshTimer();
    refreshDashboardStatusesInBackground();
  } else {
    stopDashboardRefreshTimer();
    if (view === 'data-refresh' && canRefreshData) {
      state.activeView = 'data-refresh';
    } else if (view === 'voter-list' && canViewVoterList()) {
      state.activeView = 'voter-list';
    } else if (view === 'heatmap' && canViewVotedFlag()) {
      state.activeView = 'heatmap';
    } else {
      state.activeView = 'entry';
    }
  }
  renderAppTabs();
}

function renderAppTabs() {
  if (!els.appTabs || !els.entrySection || !els.dashboardSection || !els.entryTabBtn || !els.dashboardTabBtn || !els.dataRefreshSection || !els.dataRefreshTabBtn) {
    return;
  }

  const canUseDashboard = canViewDashboard();
  const canRefreshData  = canUseDataRefresh();
  const canSeeVoterList = canViewVoterList();
  const canSeeHeatmap   = canViewVotedFlag();
  els.appTabs.style.display = canUseDashboard ? 'flex' : 'none';
  els.dashboardTabBtn.style.display  = canUseDashboard  ? 'inline-flex' : 'none';
  els.dataRefreshTabBtn.style.display= canRefreshData   ? 'inline-flex' : 'none';
  if (els.voterListTabBtn) els.voterListTabBtn.style.display = canSeeVoterList ? 'inline-flex' : 'none';
  if (els.heatmapTabBtn)   els.heatmapTabBtn.style.display   = canSeeHeatmap   ? 'inline-flex' : 'none';

  if (!canUseDashboard && !canRefreshData) {
    state.activeView = 'entry';
  } else if (state.activeView === 'dashboard'    && !canUseDashboard)  { state.activeView = 'entry'; }
  else if   (state.activeView === 'data-refresh' && !canRefreshData)   { state.activeView = 'entry'; }
  else if   (state.activeView === 'voter-list'   && !canSeeVoterList)  { state.activeView = 'entry'; }
  else if   (state.activeView === 'heatmap'      && !canSeeHeatmap)    { state.activeView = 'entry'; }

  const entryActive      = state.activeView === 'entry';
  const dashboardActive  = state.activeView === 'dashboard'   && canUseDashboard;
  const dataRefreshActive= state.activeView === 'data-refresh'&& canRefreshData;
  const voterListActive  = state.activeView === 'voter-list'  && canSeeVoterList;
  const heatmapActive    = state.activeView === 'heatmap'     && canSeeHeatmap;
  els.entrySection.style.display       = entryActive       ? 'block' : 'none';
  els.dashboardSection.style.display   = dashboardActive   ? 'block' : 'none';
  els.dataRefreshSection.style.display = dataRefreshActive ? 'block' : 'none';
  if (els.voterListSection)  els.voterListSection.style.display  = voterListActive  ? 'block' : 'none';
  if (els.heatmapSection)    els.heatmapSection.style.display    = heatmapActive    ? 'block' : 'none';
  els.entryTabBtn.classList.toggle('active', entryActive);
  els.dashboardTabBtn.classList.toggle('active', dashboardActive);
  els.dataRefreshTabBtn.classList.toggle('active', dataRefreshActive);
  if (els.voterListTabBtn) els.voterListTabBtn.classList.toggle('active', voterListActive);
  if (els.heatmapTabBtn)   els.heatmapTabBtn.classList.toggle('active', heatmapActive);

  if (entryActive) {
    renderVoters();
  }
  if (dashboardActive) {
    renderDashboard();
  }
  if (voterListActive) {
    initVoterListIfNeeded();
  }
  if (heatmapActive) {
    initHeatmapIfNeeded();
  }
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
    const completed = getCompletedCountFromCache(cached);
    const calculatedPct = total ? Math.round((completed / total) * 100) : 0;
    const backendPct = Number(cached?.completionPct || 0);
    const completionPct = Math.max(calculatedPct, backendPct);
    const isComplete = total > 0 && (completed >= total || completionPct >= 100);

    return {
      boothNo,
      village: booth.village || '',
      mandal: booth.mandal || '',
      total,
      completed,
      pending: Math.max(total - completed, 0),
      completionPct,
      isComplete,
      loaded: !!cached,
      summary
    };
  });
}

function getDashboardBoothStatusClass(item) {
  if (item.isComplete) return 'dashboard-booth-complete';
  return 'dashboard-booth-incomplete';
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

function aggregateSummary(items) {
  return items.reduce((agg, item) => {
    const s = item.summary || {};
    agg.A += s.A || 0; agg.B += s.B || 0; agg.C += s.C || 0;
    agg.D += s.D || 0; agg.E += s.E || 0;
    return agg;
  }, { A: 0, B: 0, C: 0, D: 0, E: 0 });
}

// ── Win Score helpers ─────────────────────────────────────────────────────────
// Weights: A=confirmed BJP/NDA, B=NDA allied, C=sympathiser, D=undecided, E=opposition
const WIN_WEIGHTS = { A: 1.0, B: 0.8, C: 0.55, D: 0.20, E: 0.0 };
// Historical NDA share weights — 2024 LS most recent (0.5), 2021 assembly (0.35), 2016 assembly (0.15)
const HIST_WEIGHT = { y2016: 0.15, y2021: 0.35, y2024: 0.50 };
// Fallback NDA share when no history exists (constituency average ~45%)
const FALLBACK_NDA_SHARE = 0.45;

function getStaticBoothConfig(boothNo) {
  return state.staticData?.booths?.find(b => Number(b.booth) === Number(boothNo)) || null;
}

/** Compute weighted historical NDA share for a booth config object. */
function calcHistNDA(cfg) {
  const n16 = cfg?.nda2016 || 0;
  const n21 = cfg?.nda2021 || 0;
  const n24 = cfg?.nda2024 || 0;
  // Use as many years as available, re-normalise weights
  const entries = [
    [n16, HIST_WEIGHT.y2016],
    [n21, HIST_WEIGHT.y2021],
    [n24, HIST_WEIGHT.y2024]
  ].filter(([v]) => v > 0);
  if (!entries.length) return FALLBACK_NDA_SHARE;
  const wSum = entries.reduce((s, [, w]) => s + w, 0);
  return entries.reduce((s, [v, w]) => s + v * (w / wSum), 0);
}

/**
 * Calculate win score for a single booth.
 * NDA = BJP + ADMK combined vote share from historical elections.
 */
function calcWinScore(summary, boothNo) {
  const cfg = getStaticBoothConfig(boothNo);
  const { A=0, B=0, C=0, D=0, E=0 } = summary || {};
  const tagged = A + B + C + D + E;
  const total = Number(cfg?.totalVoters) || 0;

  const histNDA = calcHistNDA(cfg);

  const p21 = cfg?.poll2021 || 0;
  const p24 = cfg?.poll2024 || 0;
  const avgPoll = (p21 && p24) ? (p21 + p24) / 2 : p24 || p21 || 0.75;

  const affinityNDA = tagged > 0
    ? (A * WIN_WEIGHTS.A + B * WIN_WEIGHTS.B + C * WIN_WEIGHTS.C + D * WIN_WEIGHTS.D) / tagged
    : histNDA;

  const coverage = total > 0 ? Math.min(tagged / total, 1) : 0;
  const blended  = affinityNDA * coverage + histNDA * (1 - coverage);

  return {
    score:    Math.round(blended  * 100),
    coverage: Math.round(coverage * 100),
    avgPoll:  Math.round(avgPoll  * 100),
    histNDA:  Math.round(histNDA  * 100),
    nda2016:  cfg?.nda2016 || null,
    nda2021:  cfg?.nda2021 || null,
    nda2024:  cfg?.nda2024 || null
  };
}

/**
 * Aggregate win score across a group of booth status items.
 * Uses poll turnout as vote-cast weight so large high-turnout booths contribute more.
 */
function calcGroupWinScore(boothStatuses) {
  let totalExpNDA = 0, totalExpCast = 0, totalTagged = 0, totalVoters = 0;
  let totalHistWeighted = 0, totalPollWeighted = 0;

  boothStatuses.forEach(item => {
    const cfg = getStaticBoothConfig(item.boothNo);
    const { A=0, B=0, C=0, D=0, E=0 } = item.summary || {};
    const tagged = A + B + C + D + E;
    const total  = Number(cfg?.totalVoters || item.total) || 0;

    const histNDA = calcHistNDA(cfg);
    const p21 = cfg?.poll2021 || 0, p24 = cfg?.poll2024 || 0;
    const avgPoll = (p21 && p24) ? (p21 + p24) / 2 : p24 || p21 || 0.75;

    const affinityNDA = tagged > 0
      ? (A * WIN_WEIGHTS.A + B * WIN_WEIGHTS.B + C * WIN_WEIGHTS.C + D * WIN_WEIGHTS.D) / tagged
      : histNDA;
    const coverage = total > 0 ? Math.min(tagged / total, 1) : 0;
    const blended  = affinityNDA * coverage + histNDA * (1 - coverage);

    const expCast = total * avgPoll;
    totalExpNDA       += blended  * expCast;
    totalExpCast      += expCast;
    totalTagged       += tagged;
    totalVoters       += total;
    totalHistWeighted += histNDA  * total;
    totalPollWeighted += avgPoll  * total;
  });

  return {
    score:   totalExpCast > 0 ? Math.round((totalExpNDA       / totalExpCast) * 100) : 0,
    coverage:totalVoters > 0  ? Math.round((totalTagged       / totalVoters)  * 100) : 0,
    histNDA: totalVoters > 0  ? Math.round((totalHistWeighted / totalVoters)  * 100) : 0,
    avgPoll: totalVoters > 0  ? Math.round((totalPollWeighted / totalVoters)  * 100) : 0
  };
}

/**
 * Render a win score badge with label and status class.
 * showDetail = true adds coverage tooltip text.
 *
 * Coverage tiers:
 *   0%        → gray "No Tagging Data" — shows historical % for context only
 *   1–14%     → amber warning "Historical (Low Coverage)"
 *   ≥ 15%     → normal colored win score prediction
 */
function renderWinScoreBadge(ws, showDetail) {
  if (!ws) return '';
  const { score, coverage, avgPoll, histNDA } = ws;

  // No tagging yet — show NDA historical average from past elections
  if (coverage === 0) {
    const projScore = histNDA || score;
    if (!projScore) return `<span class="win-score-badge ws--no-data">No Data</span>`;
    const histCls = projScore >= 50 ? 'ws--strong'
                  : projScore >= 42 ? 'ws--likely'
                  : projScore >= 33 ? 'ws--competitive'
                  : 'ws--atrisk';
    const yrs = [
      ws.nda2016 != null ? `2016: ${Math.round(ws.nda2016*100)}%` : null,
      ws.nda2021 != null ? `2021: ${Math.round(ws.nda2021*100)}%` : null,
      ws.nda2024 != null ? `2024: ${Math.round(ws.nda2024*100)}%` : null
    ].filter(Boolean).join(' · ');
    const detail = showDetail && yrs
      ? `<span class="ws-detail">(NDA: ${yrs} · Turnout ~${avgPoll || '?'}%)</span>`
      : '';
    return `<span class="win-score-badge ws--historical ${histCls}">${projScore}% <em>Past Election Avg</em>${detail}</span>`;
  }

  // Very low coverage — flag as partially informed
  if (coverage < 15) {
    const detail = showDetail
      ? `<span class="ws-detail">(${coverage}% surveyed · Past NDA avg ${histNDA}% · Turnout ~${avgPoll}%)</span>`
      : `<span class="ws-detail">${coverage}% surveyed</span>`;
    return `<span class="win-score-badge ws--low-coverage">${score}% <em>Early Est. (${coverage}% surveyed)</em>${detail}</span>`;
  }

  // Sufficient coverage — blended affinity + history prediction
  const cls = score >= 50 ? 'ws--strong'
            : score >= 42 ? 'ws--likely'
            : score >= 33 ? 'ws--competitive'
            : 'ws--atrisk';
  const label = score >= 50 ? 'On Track'
              : score >= 42 ? 'Likely'
              : score >= 33 ? 'Tight'
              : 'Needs Attention';
  const detail = showDetail
    ? ` <span class="ws-detail">(${coverage}% surveyed · Past NDA avg ${histNDA}% · Turnout ~${avgPoll}%)</span>`
    : `<span class="ws-detail">${coverage}% surveyed</span>`;
  return `<span class="win-score-badge ${cls}">${score}% <em>${label}</em>${detail}</span>`;
}

function renderAffinitySummaryBadges(summary) {
  const s = summary || { A: 0, B: 0, C: 0, D: 0, E: 0 };
  return ['A','B','C','D','E'].map(k =>
    `<span class="aff-badge aff-badge-${k}">${k} <strong>${formatNumberIndian(s[k] || 0)}</strong></span>`
  ).join('');
}

function groupBoothStatusesByMandal(boothStatuses) {
  const groups = new Map();

  boothStatuses.forEach(item => {
    const key = (item.mandal || 'Unassigned Mandal').trim() || 'Unassigned Mandal';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  });

  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([mandal, items]) => {
      const totalVoters = items.reduce((sum, item) => sum + item.total, 0);
      const completedVoters = items.reduce((sum, item) => sum + item.completed, 0);
      const totalBooths = items.length;
      const completedBooths = items.filter(item => item.isComplete).length;
      const completionPct = totalVoters ? Math.round((completedVoters / totalVoters) * 100) : 0;
      return {
        mandal,
        totalVoters,
        completedVoters,
        totalBooths,
        completedBooths,
        completionPct,
        summary: aggregateSummary(items),
        items: items.sort((a, b) => a.boothNo - b.boothNo)
      };
    });
}

function getDashboardSelectedBoothConfig() {
  return state.allBoothMap.get(Number(state.dashboardSelectedBooth)) || null;
}

function getMandalPresident(mandalName) {
  if (!state.staticData?.users) return null;
  return state.staticData.users.find(u =>
    String(u.role || '').toLowerCase() === 'mandal president' &&
    String(u.mandal || '').trim().toUpperCase() === String(mandalName || '').trim().toUpperCase()
  ) || null;
}

function renderDashboardSummaryMetrics(metrics) {
  if (!els.dashboardSummary) return;

  const boothPct  = metrics.totalBooths  ? Math.round((metrics.completedBooths  / metrics.totalBooths)  * 100) : 0;
  const voterPct  = metrics.completionPct;

  els.dashboardSummary.innerHTML = `
    <div class="dashboard-metric">
      <strong>${formatNumberIndian(metrics.totalVoters)}</strong>
      <span>Total Voters</span>
    </div>
    <div class="dashboard-metric">
      <strong>${formatNumberIndian(metrics.totalBooths)}</strong>
      <span>Total Booths</span>
    </div>
    <div class="dashboard-metric">
      <strong>${formatNumberIndian(metrics.completedBooths)}</strong>
      <span>Booths Completed</span>
    </div>
    <div class="dashboard-metric">
      <strong>${formatNumberIndian(metrics.completedVoters)}</strong>
      <span>Voters Updated</span>
    </div>
    <div class="dashboard-metric">
      <strong>${formatNumberIndian(metrics.pendingVoters)}</strong>
      <span>Voters Pending</span>
    </div>
    <div class="dashboard-metric">
      <strong>${voterPct}%</strong>
      <span>Overall Completion</span>
    </div>
    <div class="dashboard-summary-progress">
      <div class="dashboard-summary-progress-row">
        <span class="dashboard-summary-progress-label">Voters Updated</span>
        <span class="dashboard-summary-progress-val">${formatNumberIndian(metrics.completedVoters)} / ${formatNumberIndian(metrics.totalVoters)}</span>
      </div>
      <div class="dashboard-summary-bar-wrap">
        <div class="dashboard-summary-bar" style="width:${voterPct}%"></div>
      </div>
      <div class="dashboard-summary-progress-row">
        <span class="dashboard-summary-progress-label">Booths Completed</span>
        <span class="dashboard-summary-progress-val">${formatNumberIndian(metrics.completedBooths)} / ${formatNumberIndian(metrics.totalBooths)}</span>
      </div>
      <div class="dashboard-summary-bar-wrap dashboard-summary-bar-wrap--booths">
        <div class="dashboard-summary-bar" style="width:${boothPct}%"></div>
      </div>
    </div>
    <div class="dashboard-affinity-panel">
      <div class="dashboard-affinity-panel-header">
        <div class="dashboard-affinity-panel-title">Voter Affinity Breakdown</div>
        ${metrics.winScore ? `<div class="dashboard-win-score-summary">${renderWinScoreBadge(metrics.winScore, true)}</div>` : ''}
      </div>
      <div class="dashboard-affinity-panel-row">
        ${['A','B','C','D','E'].map(k => {
          const val = (metrics.summary || {})[k] || 0;
          const labels = { A:'BJP உறுதி', B:'NDA வாக்கு', C:'ஆதரவு', D:'முடிவில்லை', E:'எதிர்ப்பு' };
          return `<div class="dashboard-affinity-cell dashboard-affinity-cell--${k}">
            <div class="dac-letter">${k}</div>
            <div class="dac-value">${formatNumberIndian(val)}</div>
            <div class="dac-label">${labels[k]}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderDashboardBoothDetails() {
  if (!els.dashboardBoothDetails) return;

  if (!canViewDashboard()) {
    els.dashboardBoothDetails.innerHTML = '';
    return;
  }

  if (!state.dashboardSelectedMandal) {
    els.dashboardBoothDetails.innerHTML = '<div class="muted">Select a mandal to view grouped booth details.</div>';
    return;
  }

  const booth = getDashboardSelectedBoothConfig();
  if (!booth) {
    els.dashboardBoothDetails.innerHTML = '<div class="muted">Select a booth tile to see details.</div>';
    return;
  }

  if (state.dashboardDetailLoading) {
    els.dashboardBoothDetails.innerHTML = `<div class="muted">Loading details for Booth ${booth.booth}...</div>`;
    return;
  }

  const cached = state.pageCache[Number(booth.booth)];
  const summary = cached?.summary || { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const total = Number(booth.totalVoters) || 0;
  const completed = getCompletedCountFromCache(cached);
  const pending = Math.max(total - completed, 0);
  const completionPct = total ? Math.round((completed / total) * 100) : 0;
  const ws = calcWinScore(summary, booth.booth);
  const contacts = getBoothContacts(booth.booth);
  const contactMap = new Map(contacts.map(contact => [contact.role, contact]));
  const cfg = getStaticBoothConfig(booth.booth);

  els.dashboardBoothDetails.innerHTML = `
    <div class="dashboard-detail-header">
      <div>
        <strong>Booth ${booth.booth}</strong>
        <span>${booth.village || '-'} | ${booth.mandal || '-'}</span>
      </div>
      <div class="dashboard-village-completion">${completionPct}%</div>
    </div>
    <div class="detail-grid detail-grid-selection">
      <div><strong>Mandal</strong><span>${booth.mandal || '-'}</span></div>
      <div><strong>Village/Town</strong><span>${booth.village || '-'}</span></div>
      <div><strong>Booth Rating</strong>${renderBoothRatingBadge(booth.boothRating)}</div>
    </div>
    <div class="detail-grid detail-grid-location">
      <div><strong>Polling Station</strong><span>${booth.pollingStation || '-'}</span></div>
      <div><strong>Status</strong><span>${formatNumberIndian(completed)}/${formatNumberIndian(total)} completed | ${formatNumberIndian(pending)} pending</span></div>
    </div>
    <div class="dashboard-detail-summary">
      <div class="dashboard-detail-metric"><strong>${formatNumberIndian(summary.A || 0)}</strong><span>A</span></div>
      <div class="dashboard-detail-metric"><strong>${formatNumberIndian(summary.B || 0)}</strong><span>B</span></div>
      <div class="dashboard-detail-metric"><strong>${formatNumberIndian(summary.C || 0)}</strong><span>C</span></div>
      <div class="dashboard-detail-metric"><strong>${formatNumberIndian(summary.D || 0)}</strong><span>D</span></div>
      <div class="dashboard-detail-metric"><strong>${formatNumberIndian(summary.E || 0)}</strong><span>E</span></div>
    </div>
    <div class="booth-win-score-row">
      ${renderWinScoreBadge(ws, true)}
      <span class="ws-history muted">
        NDA: 2016 ${cfg?.nda2016 ? Math.round(cfg.nda2016*100)+'%' : 'N/A'}
        &nbsp;·&nbsp; 2021 ${cfg?.nda2021 ? Math.round(cfg.nda2021*100)+'%' : 'N/A'}
        &nbsp;·&nbsp; 2024 ${cfg?.nda2024 ? Math.round(cfg.nda2024*100)+'%' : 'N/A'}
        &nbsp;·&nbsp; Turnout ~${ws.avgPoll}%
      </span>
    </div>
    <div class="booth-detail-demographics">
      <div class="bdd-section">
        <div class="bdd-title">Religion</div>
        <div class="bdd-row">
          <span class="bdd-item bdd-hindu">Hindu <strong>${formatNumberIndian(cfg?.rHindu || 0)}</strong></span>
          <span class="bdd-item bdd-christian">Christian <strong>${formatNumberIndian(cfg?.rChristian || 0)}</strong></span>
          <span class="bdd-item bdd-muslim">Muslim <strong>${formatNumberIndian(cfg?.rMuslim || 0)}</strong></span>
          ${cfg?.rOthers ? `<span class="bdd-item bdd-others">Others <strong>${formatNumberIndian(cfg.rOthers)}</strong></span>` : ''}
        </div>
      </div>
      <div class="bdd-section">
        <div class="bdd-title">Membership</div>
        <div class="bdd-row">
          <span class="bdd-item bdd-bjp">BJP Members <strong>${formatNumberIndian(cfg?.bjpMembers || 0)}</strong></span>
        </div>
      </div>
    </div>
    <div class="contact-grid">
      ${renderSelectionContactCards(contactMap, 'Not assigned')}
    </div>
  `;
}

async function onDashboardBoothTileClick(e) {
  const boothNo = Number(e.currentTarget.dataset.dashboardBooth || 0);
  if (!boothNo) return;

  state.dashboardSelectedBooth = boothNo;
  state.dashboardDetailLoading = !state.pageCache[boothNo];
  renderDashboard();

  if (!state.dashboardDetailLoading) return;

  try {
    await fetchBoothData(boothNo);
  } catch (err) {
    console.error(`Unable to load dashboard details for booth ${boothNo}:`, err.message || err);
  } finally {
    state.dashboardDetailLoading = false;
    renderDashboard();
  }
}

function renderDashboard() {
  if (!els.dashboardSection || !els.dashboardSummary || !els.dashboardBoothList || !els.dashboardScope || !els.dashboardRefreshState) {
    return;
  }

  if (!canViewDashboard()) {
    return;
  }

  renderDashboardFilters();

  const dashboardBooths = getDashboardScopedBooths();
  if (!state.dashboardSelectedMandal) {
    els.dashboardScope.textContent = `${state.user?.role || ''} scope: ${getDashboardScopeLabel()}`;
    els.dashboardRefreshState.textContent = 'Select a mandal';
    renderDashboardSummaryMetrics({
      totalVoters: 0,
      totalBooths: 0,
      completedBooths: 0,
      completedVoters: 0,
      pendingVoters: 0,
      completionPct: 0
    });
    els.dashboardBoothList.innerHTML = '<div class="muted">Select a mandal to view booths grouped by Village / Town.</div>';
    state.dashboardSelectedBooth = null;
    state.dashboardDetailLoading = false;
    renderDashboardBoothDetails();
    return;
  }

  if (state.dashboardSelectedBooth && !dashboardBooths.some(booth => Number(booth.booth) === Number(state.dashboardSelectedBooth))) {
    state.dashboardSelectedBooth = null;
    state.dashboardDetailLoading = false;
  }
  let boothStatuses = getAccessibleBoothStatusList(dashboardBooths);
  if (state.dashboardSelectedStatus === 'completed') {
    boothStatuses = boothStatuses.filter(item => item.total > 0 && item.completed >= item.total);
  } else if (state.dashboardSelectedStatus === 'pending') {
    boothStatuses = boothStatuses.filter(item => item.total === 0 || item.completed < item.total);
  }
  const loadedCount = boothStatuses.filter(item => item.loaded).length;
  const totalBooths = boothStatuses.length;
  const totalVoters = boothStatuses.reduce((sum, item) => sum + item.total, 0);
  const completedVoters = boothStatuses.reduce((sum, item) => sum + item.completed, 0);
  const completedBooths = boothStatuses.reduce((sum, item) => sum + (item.isComplete ? 1 : 0), 0);
  const pendingVoters = Math.max(totalVoters - completedVoters, 0);
  const completionPct = totalVoters ? Math.round((completedVoters / totalVoters) * 100) : 0;
  const overallSummary = aggregateSummary(boothStatuses);

  const scopeParts = [`${state.user?.role || ''} scope: ${getDashboardScopeLabel()}`];
  if (state.dashboardSelectedMandal) scopeParts.push(`Mandal: ${state.dashboardSelectedMandal === '__all__' ? 'All' : state.dashboardSelectedMandal}`);
  if (state.dashboardSelectedVillage) scopeParts.push(`Village/Town: ${state.dashboardSelectedVillage}`);
  els.dashboardScope.textContent = scopeParts.join(' | ');
  if (state.dashboardStatusRefreshInProgress) {
    els.dashboardRefreshState.textContent = `Refreshing latest status (${loadedCount}/${totalBooths} loaded)`;
  } else {
    els.dashboardRefreshState.textContent = loadedCount < totalBooths
      ? `Updating ${loadedCount}/${totalBooths} booths`
      : 'Up to date';
  }

  const overallWinScore = calcGroupWinScore(boothStatuses);
  renderDashboardSummaryMetrics({
    totalVoters,
    totalBooths,
    completedBooths,
    completedVoters,
    pendingVoters,
    completionPct,
    summary: overallSummary,
    winScore: overallWinScore
  });

  if (state.dashboardSelectedMandal === '__all__') {
    const mandalGroups = groupBoothStatusesByMandal(boothStatuses);
    if (!mandalGroups.length) {
      els.dashboardBoothList.innerHTML = '<div class="muted">No dashboard data available for the selected filters.</div>';
      state.dashboardSelectedBooth = null;
      state.dashboardDetailLoading = false;
      renderDashboardBoothDetails();
      return;
    }

    els.dashboardBoothList.innerHTML = `
      <div class="dashboard-mandal-tiles">
        ${mandalGroups.map(group => {
          const allComplete  = group.totalBooths > 0 && group.completedBooths === group.totalBooths;
          const notStarted   = group.completedVoters === 0;
          const statusClass  = allComplete ? 'dmstatus--complete' : notStarted ? 'dmstatus--not-started' : 'dmstatus--in-progress';
          const statusLabel  = allComplete ? 'Complete' : notStarted ? 'Not Started' : 'In Progress';
          const mp           = getMandalPresident(group.mandal);
          const mandalWS     = calcGroupWinScore(group.items);
          const presidentRow = mp
            ? `<div class="dashboard-mandal-tile-president">
                 <span>${mp.name}</span>
                 <a href="tel:${mp.phone}" class="dm-phone" onclick="event.stopPropagation()">&#9742; ${mp.phone}</a>
               </div>`
            : '';
          const wsBadge = renderWinScoreBadge(mandalWS, false);
          return `
          <button class="dashboard-mandal-tile" type="button" data-dashboard-mandal="${group.mandal}">
            <div class="dashboard-mandal-tile-header">
              <strong class="dashboard-mandal-tile-name">${group.mandal}</strong>
              <span class="dashboard-mandal-status ${statusClass}">${statusLabel}</span>
            </div>
            ${presidentRow}
            <div class="dashboard-mandal-tile-bar-wrap">
              <div class="dashboard-mandal-tile-bar" style="width:${group.completionPct}%"></div>
            </div>
            <div class="dashboard-mandal-tile-bar-footer">
              <span class="dashboard-mandal-tile-pct">${group.completionPct}% surveyed</span>
              ${wsBadge ? `<span class="dashboard-mandal-tile-ws-inline">${wsBadge}</span>` : ''}
            </div>
            <div class="dashboard-mandal-tile-stats">
              <span>${formatNumberIndian(group.completedBooths)}/${formatNumberIndian(group.totalBooths)} booths</span>
              <span>${formatNumberIndian(group.completedVoters)}/${formatNumberIndian(group.totalVoters)} voters updated</span>
            </div>
            <div class="dashboard-mandal-tile-aff">
              ${renderAffinitySummaryBadges(group.summary)}
            </div>
          </button>`;
        }).join('')}
      </div>
    `;
    els.dashboardBoothList.querySelectorAll('[data-dashboard-mandal]').forEach(btn => {
      btn.addEventListener('click', onDashboardMandalTileClick);
    });
    state.dashboardSelectedBooth = null;
    renderDashboardBoothDetails();
    return;
  }

  const villageGroups = groupBoothStatusesByVillage(boothStatuses);
  if (!villageGroups.length) {
    els.dashboardBoothList.innerHTML = '<div class="muted">No dashboard data available for the selected filters.</div>';
    state.dashboardSelectedBooth = null;
    state.dashboardDetailLoading = false;
    renderDashboardBoothDetails();
    return;
  }

  els.dashboardBoothList.innerHTML = villageGroups.map(group => `
    <section class="dashboard-village-group">
      <div class="dashboard-village-header">
        <div class="dashboard-village-title">
          <strong>${group.village}</strong>
          <span>${formatNumberIndian(group.completedVoters)}/${formatNumberIndian(group.totalVoters)} voters completed</span>
        </div>
        <div class="dashboard-village-completion">${group.completionPct}%</div>
      </div>
      <div class="dashboard-village-tiles">
        ${group.items.map(item => `
          <button class="dashboard-row ${getDashboardBoothStatusClass(item)}${Number(state.dashboardSelectedBooth) === Number(item.boothNo) ? ' is-selected' : ''}" type="button" data-dashboard-booth="${item.boothNo}">
            <div class="dashboard-row-main">
              <div class="dashboard-row-title">
                <strong>Booth ${item.boothNo}</strong>
                ${renderBoothRatingBadge(state.allBoothMap.get(Number(item.boothNo))?.boothRating, { compact: true })}
              </div>
            </div>
            <div class="dashboard-row-meta">
              <span>${item.completionPct}%</span>
              <span>${formatNumberIndian(item.completed)}/${formatNumberIndian(item.total)}</span>
            </div>
          </button>
        `).join('')}
      </div>
    </section>
  `).join('');
  els.dashboardBoothList.querySelectorAll('[data-dashboard-booth]').forEach(btn => {
    btn.addEventListener('click', onDashboardBoothTileClick);
  });
  renderDashboardBoothDetails();
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
  els.submitAffinityBtn.disabled = !(hasBooth && hasVoters && canSubmitBoothChanges());
}

function affinityButton(code, current, slNo, locked) {
  const active = current === code ? 'active' : '';
  const disabledAttr = locked ? 'disabled' : '';
  return `
    <button class="affinity-btn affinity-${code} ${active}" data-sl="${slNo}" data-affinity="${code}" type="button" ${disabledAttr}>
      ${code}
    </button>
  `;
}

function getDisplayVoters() {
  const voters = state.boothData?.voters || [];
  return state.pendingVotersFilter ? voters.filter(v => !v.affinity) : voters;
}

function getCurrentPageBounds() {
  const voters = getDisplayVoters();
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
  return !!voter.affinity;
}

function cancelBoothPrefetch() {
  state.prefetchToken++;
  state.prefetchStarted = false;
  if (state.pendingPrefetchTimer) {
    clearTimeout(state.pendingPrefetchTimer);
    state.pendingPrefetchTimer = null;
  }
}

function getPrefetchBoothOrder(priorityBoothNo = 0) {
  const boothNumbers = state.booths.map(b => Number(b.booth)).filter(Boolean);
  if (!priorityBoothNo) return boothNumbers;

  const index = boothNumbers.indexOf(Number(priorityBoothNo));
  if (index < 0) return boothNumbers;

  return boothNumbers
    .slice(index + 1)
    .concat(boothNumbers.slice(0, index + 1));
}

function queueWarmBoothCache(options = {}) {
  if (!state.booths.length || state.prefetchStarted || state.pendingPrefetchTimer) return;

  const expectedToken = state.prefetchToken;
  const delayMs = Number(options.delayMs || BOOTH_PREFETCH_DELAY_MS);

  state.pendingPrefetchTimer = setTimeout(() => {
    state.pendingPrefetchTimer = null;
    if (expectedToken !== state.prefetchToken) return;
    warmBoothCache(options);
  }, delayMs);
}

function renderVoterRow(v) {
  const canEditRows = canEditAnyRows();
  const saved = !!v.affinity;
  const rowClass = saved ? ' voter-row-saved' : '';
  const selectedAffinity = v.affinity || '';
  const showRelocated = canViewRelocatedFlag();
  const showVoted = canViewVotedFlag();
  const locked = !canEditRows || saved;
  return `
    <div class="voter-row${rowClass}" data-voter-sl="${v.slNo}">
      <div class="voter-row-header">
        <div class="sl-box">வாக்காளர் வரிசை எண் : ${v.slNo}</div>
        ${selectedAffinity ? `<div class="selected-affinity"><strong>${selectedAffinity}</strong></div>` : ''}
        ${saved ? `<span class="voter-row-locked-badge">Saved</span>` : ''}
      </div>
      <div class="voter-flags">
        ${showRelocated ? `
          <label class="voter-flag-checkbox${v.relocated ? ' is-checked' : ''}">
            <input type="checkbox" class="voter-flag-input" data-sl="${v.slNo}" data-flag="relocated" ${v.relocated ? 'checked' : ''} ${canEditRelocatedFlag() ? '' : 'disabled'}>
            <span>Relocated</span>
          </label>
        ` : ''}
        ${showVoted ? `
          <label class="voter-flag-checkbox${v.voted ? ' is-checked' : ''}">
            <input type="checkbox" class="voter-flag-input" data-sl="${v.slNo}" data-flag="voted" ${v.voted ? 'checked' : ''} disabled>
            <span>Voted</span>
          </label>
        ` : ''}
      </div>
      <div class="affinity-group">
        ${affinityButton('A', v.affinity, v.slNo, locked)}
        ${affinityButton('B', v.affinity, v.slNo, locked)}
        ${affinityButton('C', v.affinity, v.slNo, locked)}
        ${affinityButton('D', v.affinity, v.slNo, locked)}
        ${affinityButton('E', v.affinity, v.slNo, locked)}
      </div>
    </div>
  `;
}

function updateVoterRowEl(slNo) {
  const voter = state.boothData?.voters?.find(v => v.slNo === slNo);
  if (!voter) return;
  const rowEl = els.votersContainer.querySelector(`[data-voter-sl="${slNo}"]`);
  if (!rowEl) return;
  rowEl.outerHTML = renderVoterRow(voter);
}

function renderVoters() {
  const allVoters = state.boothData?.voters || [];
  if (!allVoters.length) {
    els.votersContainer.innerHTML = isEntryAggregateViewActive()
      ? `<div class="muted">${getEntryAggregateStatusMessage()}</div>`
      : state.selectedBooth
        ? '<div class="muted">No voters found for this booth</div>'
        : '';
    return;
  }

  const pendingCount = allVoters.filter(v => !v.affinity).length;
  const voters = getDisplayVoters();
  const { start, end, totalPages } = getCurrentPageBounds();
  const pageRows = voters.slice(start, end);
  const showingFrom = voters.length ? start + 1 : 0;
  const showingTo = Math.min(end, voters.length);

  els.votersContainer.innerHTML = `
    <div class="voters-toolbar">
      <div class="voters-toolbar-group">
        <button id="prevPageBtn" type="button" ${state.currentPage === 1 ? 'disabled' : ''}>Previous</button>
        <button id="nextPageBtn" type="button" ${state.currentPage === totalPages ? 'disabled' : ''}>Next</button>
        <span><strong>Page ${state.currentPage} of ${totalPages}</strong></span>
        <span class="muted">${state.pendingVotersFilter ? `${showingFrom}–${showingTo} of ${voters.length} pending` : `SL# ${showingFrom} to ${showingTo}`}</span>
      </div>
      <div class="voters-toolbar-group">
        <label class="pending-filter-label">
          <input type="checkbox" id="pendingVotersChk" ${state.pendingVotersFilter ? 'checked' : ''}>
          Pending Voters <span class="pending-filter-count">(${pendingCount})</span>
        </label>
      </div>
      <div class="toolbar-buttons">
        <button id="submitAffinityBtn" type="button">Submit</button>
        ${normalizeRole(state.user?.role) === 'admin' && state.selectedBooth ? `<button id="clearInputBtn" type="button" class="btn-clear">Clear Input</button>` : ''}
      </div>
    </div>

    ${pageRows.length ? pageRows.map(renderVoterRow).join('') : '<div class="muted" style="padding:16px 0;">No pending voters — all entries are complete.</div>'}
  `;

  els.submitAffinityBtn = byId('submitAffinityBtn') || els.submitAffinityBtn;
  updateSubmitButton();
}

function buildBoothVoters(totalVoters) {
  const voters = [];
  for (let i = 1; i <= totalVoters; i++) {
    voters.push({ slNo: i, affinity: '', relocated: false, voted: false });
  }
  return voters;
}

function applySavedAffinity(savedRows, boothData = state.boothData, totalVoters = state.selectedBooth?.totalVoters || 0) {
  if (!boothData || !Array.isArray(boothData.voters)) return;

  const map = {};
  const affinityCodes = new Set(['A', 'B', 'C', 'D', 'E']);
  savedRows.forEach(r => {
    const slNo = Number(
      r?.slNo ??
      r?.slno ??
      r?.sl_no ??
      r?.SLNo ??
      r?.SLNO ??
      r?.serialNo ??
      r?.serial_no
    );

    if (!slNo) return;

    const rawAffinity = String(
      r?.affinity ??
      r?.Affinity ??
      r?.AFFINITY ??
      r?.value ??
      r?.Value ??
      ''
    ).trim().toUpperCase();

    map[slNo] = {
      affinity: affinityCodes.has(rawAffinity) ? rawAffinity : '',
      relocated: readTruthyFlag(
        r?.relocated ??
        r?.Relocated ??
        r?.RELOCATED
      ),
      voted: readTruthyFlag(
        r?.voted ??
        r?.Voted ??
        r?.VOTED
      )
    };
  });

  let relocatedCount = 0;
  let votedCount = 0;
  boothData.voters.forEach(v => {
    const saved = map[v.slNo] || null;
    v.affinity = saved?.affinity || '';
    v.relocated = !!saved?.relocated;
    v.voted = !!saved?.voted;
    if (v.relocated) relocatedCount++;
    if (v.voted) votedCount++;
  });

  const calc = calculateSummary(boothData.voters, totalVoters);
  boothData.summary = calc.summary;
  boothData.completionPct = calc.completionPct;
  boothData.completedCount = calc.filled;
  boothData.relocatedCount = relocatedCount;
  boothData.votedCount = votedCount;
  boothData.updatedAt = Date.now();
}

function updateBoothFlagCounts(boothData = state.boothData) {
  if (!boothData?.voters?.length) {
    if (boothData) {
      boothData.relocatedCount = 0;
      boothData.votedCount = 0;
    }
    return;
  }

  boothData.relocatedCount = boothData.voters.reduce((count, voter) => count + (voter.relocated ? 1 : 0), 0);
  boothData.votedCount = boothData.voters.reduce((count, voter) => count + (voter.voted ? 1 : 0), 0);
}

function updateLocalSelection(slNo, affinity) {
  const voter = state.boothData?.voters?.find(v => v.slNo === slNo);
  if (!voter) return;

  if (!canEditAnyRows()) return;
  if (voter.affinity) return;

  const oldAffinity = voter.affinity;
  voter.affinity = affinity;
  state.editingRows.delete(slNo);

  // Delta summary update — avoids rescanning all voters on each click
  const summary = state.boothData.summary;
  const totalVoters = state.selectedBooth?.totalVoters || 0;
  if (oldAffinity && summary.hasOwnProperty(oldAffinity)) summary[oldAffinity]--;
  if (summary.hasOwnProperty(affinity)) summary[affinity]++;
  if (!oldAffinity) state.boothData.completedCount = (state.boothData.completedCount || 0) + 1;
  state.boothData.completionPct = totalVoters
    ? Math.round((state.boothData.completedCount / totalVoters) * 100)
    : 0;
  state.boothData.updatedAt = Date.now();

  setDraftForBooth(getCurrentBoothNumber(), state.boothData);
  queueDraftPersist();
  cacheCurrentBoothData();

  renderSummary();
  if (state.pendingVotersFilter) {
    renderVoters();
  } else {
    updateVoterRowEl(slNo);
  }
  setAffinitySaveStatus('Saving changes...', 'warning');
  queueBackgroundSave();
}

function onAffinityClick(e) {
  const btn = e.target;
  if (btn.disabled) return;
  
  const slNo = Number(btn.dataset.sl);
  const affinity = btn.dataset.affinity;

  if (!slNo || !affinity) return;
  
  updateLocalSelection(slNo, affinity);
}

function onEditCheckboxChange(e) {
  const checkbox = e.target;
  const slNo = Number(checkbox.dataset.sl);
  if (!slNo) return;

  if (checkbox.checked) {
    state.editingRows.add(slNo);
  } else {
    state.editingRows.delete(slNo);
  }

  updateVoterRowEl(slNo);
}

function onVoterFlagChange(e) {
  const checkbox = e.target;
  const slNo = Number(checkbox.dataset.sl);
  const flag = String(checkbox.dataset.flag || '').trim();

  if (!slNo || !flag) return;
  if (flag === 'relocated' && !canEditRelocatedFlag()) {
    checkbox.checked = !checkbox.checked;
    return;
  }
  if (flag === 'voted') {
    checkbox.checked = !checkbox.checked; // voted is read-only in Entry; managed by Heatmap tab
    return;
  }

  const voter = state.boothData?.voters?.find(v => v.slNo === slNo);
  if (!voter) return;

  voter[flag] = checkbox.checked;
  updateBoothFlagCounts(state.boothData);
  state.boothData.updatedAt = Date.now();
  setDraftForBooth(getCurrentBoothNumber(), state.boothData);
  queueDraftPersist();
  cacheCurrentBoothData();

  const label = checkbox.closest('.voter-flag-checkbox');
  if (label) label.classList.toggle('is-checked', checkbox.checked);
  setAffinitySaveStatus('Saving changes...', 'warning');
  queueBackgroundSave();
}

async function onSaveBooth() {
  if (!canSubmitBoothChanges()) {
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

function onClearBoothData() {
  if (!state.selectedBooth) {
    console.warn('No booth selected');
    return;
  }
  
  const boothNo = Number(state.selectedBooth.booth);
  console.log('Clear button clicked for booth:', boothNo);
  if (!boothNo) {
    console.warn('Invalid booth number:', boothNo);
    return;
  }

  const confirmed = confirm(`Are you sure you want to clear all data for Booth ${boothNo}? This cannot be undone.`);
  console.log('User confirmed clear:', confirmed);
  if (!confirmed) return;

  // Step 1: Clear frontend state first
  try {
    const selected = getBoothConfig(boothNo);
    if (selected) {
      state.boothData = createBoothData(selected.totalVoters);
      state.editingRows.clear();
      clearDraftForBooth(boothNo);
      queueDraftPersist();
      state.pageCache[boothNo] = cloneBoothData(state.boothData);
      renderSummary();
      renderVoters();
      console.log('Local state cleared and UI re-rendered');
    }
  } catch (renderErr) {
    console.error('Render error during clear (continuing with backend call):', renderErr);
  }

  // Step 2: Call backend — always runs, separate from UI update
  setAffinitySaveStatus('Clearing backend data...', 'warning');
  showLoading(true);
  console.log('Sending clearBoothData request for booth:', boothNo);

  postApi({
    action: 'clearBoothData',
    booth: boothNo
  }).then(function(result) {
    console.log('Clear API response:', result);
    if (result.ok) {
      setAffinitySaveStatus('All booth data cleared successfully.', 'success');
      queueDashboardRender();
    } else {
      const errMsg = result.message || 'Unknown error';
      console.error('Backend clear failed:', errMsg);
      setAffinitySaveStatus('Backend clear failed: ' + errMsg, 'error');
    }
  }).catch(function(err) {
    console.error('API call exception:', err);
    setAffinitySaveStatus('Backend call failed: ' + (err.message || 'Network error'), 'error');
  }).finally(function() {
    showLoading(false);
  });
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
  boothData.relocatedCount = Number(result.relocatedTotal ?? boothData.relocatedCount ?? 0);
  boothData.votedCount = Number(result.votedTotal ?? boothData.votedCount ?? 0);
  state.pageCache[boothNo] = cloneBoothData(boothData);

  // Use server-authoritative vote count from save response
  state.hmVotedBooths[boothNo] = boothData.votedCount;
  if (state.activeView === 'heatmap' && state.hmActiveView === 'progress') {
    renderHmProgressView();
  }

  clearDraftForBooth(boothNo);
  queueDraftPersist();
  queueDashboardRender();

  if (isEntryAggregateViewActive() && state.boothMap.has(boothNo)) {
    renderEntryAggregateView();
  }

  if (boothNo === getCurrentBoothNumber() && state.boothData) {
    state.boothData.summary = boothData.summary;
    state.boothData.completionPct = boothData.completionPct;
    state.boothData.relocatedCount = boothData.relocatedCount;
    state.boothData.votedCount = boothData.votedCount;
    cacheCurrentBoothData();
    renderSummary();
    renderVoters();
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

  const totalPages = Math.max(1, Math.ceil(getDisplayVoters().length / state.pageSize));
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

function fetchBoothData(booth, options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const includeDrafts = options.includeDrafts !== false;
  const boothNo = Number(booth);
  const selected = getBoothConfig(boothNo);
  if (!selected) {
    return Promise.reject(new Error('Booth not found'));
  }

  if (!forceRefresh && state.pageCache[boothNo]) {
    const cached = cloneBoothData(state.pageCache[boothNo]);
    if (includeDrafts) {
      applyDraftToBoothData(cached, boothNo, selected.totalVoters || 0);
    }
    return Promise.resolve(cached);
  }

  if (state.pendingBoothLoads[boothNo]) {
    return state.pendingBoothLoads[boothNo].then(boothData => {
      const cloned = cloneBoothData(boothData);
      if (includeDrafts) {
        applyDraftToBoothData(cloned, boothNo, selected.totalVoters || 0);
      }
      return cloned;
    });
  }

  const request = (async () => {
    const boothData = createBoothData(selected.totalVoters);
    const savedRows = await loadSavedAffinity(boothNo);
    applySavedAffinity(savedRows, boothData, selected.totalVoters || 0);
    if (includeDrafts) {
      applyDraftToBoothData(boothData, boothNo, selected.totalVoters || 0);
    }
    state.pageCache[boothNo] = cloneBoothData(boothData);
    if (isEntryAggregateViewActive() && state.boothMap.has(boothNo)) {
      renderEntryAggregateView();
    }
    queueDashboardRender();
    return boothData;
  })();

  state.pendingBoothLoads[boothNo] = request;

  return request.finally(() => {
    delete state.pendingBoothLoads[boothNo];
  });
}

function warmBoothCache(options = {}) {
  if (state.prefetchStarted || !state.booths.length) return;
  state.prefetchStarted = true;

  const token = state.prefetchToken;
  const boothNumbers = getPrefetchBoothOrder(options.priorityBoothNo);
  const totalBooths = boothNumbers.length;
  const concurrency = totalBooths > 60
    ? 3
    : totalBooths > 18
      ? 3
      : Math.min(3, totalBooths);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < boothNumbers.length) {
      if (token !== state.prefetchToken || !state.user) return;
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

function refreshDashboardStatusesInBackground() {
  if (!canViewDashboard() || state.dashboardStatusRefreshInProgress) return;

  const now = Date.now();
  if (now - state.lastDashboardStatusRefreshAt < DASHBOARD_STATUS_REFRESH_INTERVAL_MS) {
    return;
  }

  const scopedBooths = getDashboardScopedBooths();
  if (!scopedBooths.length) return;

  state.dashboardStatusRefreshInProgress = true;
  state.lastDashboardStatusRefreshAt = now;
  queueDashboardRender();

  const scopePayload = {
    action: 'getDashboardSummary',
    mandal: state.dashboardSelectedMandal || '',
    village: state.dashboardSelectedVillage || ''
  };

  callApi(scopePayload)
    .then(result => {
      if (!result?.ok || !Array.isArray(result.booths)) {
        throw new Error(result?.message || 'Dashboard summary unavailable');
      }

      result.booths.forEach(row => {
        const boothNo = Number(row?.booth ?? row?.boothNo);
        if (!boothNo || !state.allBoothMap.has(boothNo)) return;
        const boothConfig = state.allBoothMap.get(boothNo);
        const total = Number(row?.totalVoters ?? boothConfig?.totalVoters ?? 0) || 0;
        const cached = state.pageCache[boothNo]
          ? cloneBoothData(state.pageCache[boothNo])
          : createBoothData(total);

        const summary = row?.summary;
        if (summary && typeof summary === 'object') {
          cached.summary = {
            A: Number(summary.A || 0),
            B: Number(summary.B || 0),
            C: Number(summary.C || 0),
            D: Number(summary.D || 0),
            E: Number(summary.E || 0)
          };
        }

        const completedCount = Number(row?.completed ?? row?.completedVoters ?? row?.filled ?? 0);
        if (completedCount >= 0) {
          cached.completedCount = completedCount;
        }

        const completionPct = Number(row?.completionPct ?? row?.completion ?? 0);
        if (completionPct >= 0) {
          cached.completionPct = completionPct;
        }

        cached.updatedAt = Date.now();
        state.pageCache[boothNo] = cloneBoothData(cached);
      });
    })
    .catch(async () => {
      // Fallback: refresh only a small stale subset instead of all booths.
      const maxRefresh = 12;
      const staleAfterMs = 2 * 60 * 1000;
      const boothNumbers = scopedBooths
        .map(booth => Number(booth.booth))
        .filter(boothNo => {
          const cached = state.pageCache[boothNo];
          if (!cached) return true;
          return Date.now() - Number(cached.updatedAt || 0) > staleAfterMs;
        })
        .slice(0, maxRefresh);

      for (const boothNo of boothNumbers) {
        try {
          await fetchBoothData(boothNo, { forceRefresh: true, includeDrafts: false });
        } catch (err) {
          console.error(`Dashboard refresh failed for booth ${boothNo}:`, err.message || err);
        }
      }
    })
    .finally(() => {
      state.dashboardStatusRefreshInProgress = false;
      queueDashboardRender();
    });
}

async function loadBoothData(booth) {
  const selected = getBoothConfig(booth);
  if (!selected) throw new Error('Booth not found');
  const loadId = ++state.activeBoothLoadId;
  // Do NOT cancel prefetch — let background warm-up continue so subsequent booth
  // selections hit the cache. Only reprioritise so the next booths are fetched first.
  state.selectedBoothAll = false;
  state.selectedBooth = selected;
  state.currentPage = 1;
  state.pendingVotersFilter = false;
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
  queueWarmBoothCache({ priorityBoothNo: Number(booth) });
}

async function onBoothChange() {
  const rawValue = els.boothSelect.value;
  if (!rawValue) {
    if (state.pendingSaveTimer) {
      clearTimeout(state.pendingSaveTimer);
      state.pendingSaveTimer = null;
      const prevBoothNo = getCurrentBoothNumber();
      if (prevBoothNo && getDraftForBooth(prevBoothNo)) {
        await saveCurrentBoothSilently({ boothNo: prevBoothNo, silentStatus: true });
      }
    }
    state.activeBoothLoadId++;
    state.selectedBoothAll = false;
    state.selectedBooth = null;
    if (!renderEntryAggregateView()) {
      state.boothData = null;
      renderBoothDetails();
      renderSummary();
      renderVoters();
      updateSubmitButton();
      setAffinitySaveStatus('');
    }
    return;
  }

  if (rawValue === '__all__') {
    if (state.pendingSaveTimer) {
      clearTimeout(state.pendingSaveTimer);
      state.pendingSaveTimer = null;
      const prevBoothNo = getCurrentBoothNumber();
      if (prevBoothNo && getDraftForBooth(prevBoothNo)) {
        await saveCurrentBoothSilently({ boothNo: prevBoothNo, silentStatus: true });
      }
    }
    state.activeBoothLoadId++;
    state.selectedBoothAll = true;
    state.selectedBooth = null;
    state.currentPage = 1;
    state.editingRows.clear();
    renderEntryAggregateView();
    return;
  }

  const booth = Number(rawValue);

  // Flush any pending save for the current booth before switching
  if (state.pendingSaveTimer) {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = null;
    const prevBoothNo = getCurrentBoothNumber();
    if (prevBoothNo && getDraftForBooth(prevBoothNo)) {
      await saveCurrentBoothSilently({ boothNo: prevBoothNo, silentStatus: true });
    }
  }

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
    return userPhone === cleanPhone && userPhone.slice(-6) === cleanPassword;
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

  const rawBooths = Array.isArray(user.booths) ? user.booths : (user.booths != null ? [user.booths] : []);
  const allowed = rawBooths.map(x => Number(x));

  return state.staticData.booths
    .filter(b => allowed.includes(Number(b.booth)))
    .sort((a, b) => a.booth - b.booth);
}

function applyVisibleBoothScope() {
  const showFilter = requiresMandalSelection();
  let scopedBooths = state.selectedMandal === '__all__'
    ? [...state.allBooths]
    : state.selectedMandal
      ? state.allBooths.filter(booth => String(booth.mandal || '').trim() === state.selectedMandal)
      : showFilter
        ? []
        : [...state.allBooths];

  syncEntryFilterState();

  if (state.selectedVillage && state.selectedVillage !== '__all__') {
    scopedBooths = scopedBooths.filter(booth => String(booth.village || '').trim() === state.selectedVillage);
  }

  state.booths = scopedBooths.sort((a, b) => a.booth - b.booth);
  state.boothMap = new Map(state.booths.map(booth => [Number(booth.booth), booth]));
  renderMandalDropdown();
  renderVillageDropdown();
  renderBoothDropdown();

  const currentBoothNo = Number(state.selectedBooth?.booth) || 0;
  if (currentBoothNo && state.boothMap.has(currentBoothNo)) {
    state.selectedBoothAll = false;
    state.selectedBooth = state.boothMap.get(currentBoothNo);
    if (els.boothSelect) els.boothSelect.value = String(currentBoothNo);
  } else if (state.selectedBoothAll && state.booths.length) {
    if (els.boothSelect) els.boothSelect.value = '__all__';
    renderEntryAggregateView();
  } else if (hasScopedEntryAggregateView()) {
    if (els.boothSelect) els.boothSelect.value = '';
    renderEntryAggregateView();
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
  cancelBoothPrefetch();
  const availableMandals = getAvailableMandals();
  if (!requiresMandalSelection()) {
    state.selectedMandal = '';
    state.selectedVillage = '';
    state.selectedBoothAll = false;
  } else if (state.selectedMandal && state.selectedMandal !== '__all__' && !availableMandals.includes(state.selectedMandal)) {
    state.selectedMandal = '';
  }
  syncEntryFilterState();
  syncDashboardFilterState();

  renderUser();
  applyVisibleBoothScope();
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
  state.selectedVillage = '';
  cancelBoothPrefetch();
  applyVisibleBoothScope();
}

function onVillageChange() {
  if (!els.villageSelect) return;
  state.selectedVillage = els.villageSelect.value || '';
  cancelBoothPrefetch();
  applyVisibleBoothScope();
}

function onDashboardMandalChange() {
  if (!els.dashboardMandalSelect) return;
  // Treat empty selection as __all__ so summary stays visible
  state.dashboardSelectedMandal = els.dashboardMandalSelect.value || '__all__';
  state.lastDashboardStatusRefreshAt = 0;
  syncDashboardFilterState();
  refreshDashboardStatusesInBackground();
  renderDashboard();
}

function onDashboardRefresh() {
  // Force-reset both throttle and in-progress flag so a stuck refresh can recover
  state.lastDashboardStatusRefreshAt = 0;
  state.dashboardStatusRefreshInProgress = false;
  if (!state.dashboardSelectedMandal) {
    state.dashboardSelectedMandal = '__all__';
  }
  renderDashboardFilters();
  refreshDashboardStatusesInBackground();
  renderDashboard();
}

function onDashboardVillageChange() {
  if (!els.dashboardVillageSelect) return;
  state.dashboardSelectedVillage = els.dashboardVillageSelect.value || '';
  state.lastDashboardStatusRefreshAt = 0;
  refreshDashboardStatusesInBackground();
  renderDashboard();
}

function onDashboardStatusChange() {
  if (!els.dashboardStatusSelect) return;
  state.dashboardSelectedStatus = els.dashboardStatusSelect.value || '';
  renderDashboard();
}

function onDashboardMandalTileClick(e) {
  const mandal = e.currentTarget.dataset.dashboardMandal;
  if (!mandal) return;
  state.dashboardSelectedMandal = mandal;
  state.dashboardSelectedVillage = '';
  state.dashboardSelectedBooth = null;
  state.lastDashboardStatusRefreshAt = 0;
  syncDashboardFilterState();
  refreshDashboardStatusesInBackground();
  renderDashboard();
}

async function refreshStaticDataInBackground(options = {}) {
  const previousData = state.staticData
    ? structuredClone(state.staticData)
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
  cancelBoothPrefetch();

  els.loginSection.style.display = 'none';
  els.appSection.style.display = 'block';

  refreshAccessibleDataForUser(user);
  syncPendingDrafts();
}

function logout() {
  persistDraftsNow();
  cancelBoothPrefetch();
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
  stopDashboardRefreshTimer();
  state.user = null;
  state.allBooths = [];
  state.allBoothMap = new Map();
  state.booths = [];
  state.boothMap = new Map();
  state.selectedMandal = '';
  state.selectedVillage = '';
  state.selectedBoothAll = false;
  state.dashboardSelectedMandal = '';
  state.dashboardSelectedVillage = '';
  state.dashboardSelectedBooth = null;
  state.dashboardDetailLoading = false;
  state.selectedBooth = null;
  state.boothData = null;
  state.pageCache = {};
  state.pendingBoothLoads = {};
  state.dashboardStatusRefreshInProgress = false;
  state.lastDashboardStatusRefreshAt = 0;
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
  if (els.dashboardSection)  els.dashboardSection.style.display  = 'none';
  if (els.dataRefreshSection)els.dataRefreshSection.style.display= 'none';
  if (els.voterListSection)  els.voterListSection.style.display  = 'none';
  if (els.heatmapSection)    els.heatmapSection.style.display    = 'none';
  state.vlBoothData        = null;
  state.vlLoadedBooth      = null;
  state.vlFiltersPopulated = false;
  state.vlFiltered         = [];
  state.vlPage             = 1;
  state.hmBoothNo          = null;
  state.hmVoters           = [];
  state.hmFiltersPopulated = false;
  state.hmActiveView       = 'heatmap';
  state.hmProgSubView      = 'nda';
  state.hmProgActiveMandal = null;
  state.hmProgLoading        = false;
  state.hmProgAutoRefreshed  = false;
  state.hmVotedBooths        = {};
  state.hmVotedSlNos         = {};
  state.activeView    = 'entry';
  updateSubmitButton();
}

// ── Voter List ───────────────────────────────────────────────────────────────
// Data is loaded per-booth from voter_data/{boothNo}.json (~51KB each).
// Nothing is fetched until an admin selects a specific booth.

const VL_PAGE_SIZE = 100;
// cols order inside each per-booth file row:
// [sl, epic, name, relation, house, age, gender, deleted, phone, bjp, religion]
const VL_COLS = ['sl','epic','name','relation','house','age','gender','deleted','phone','bjp','religion'];

// Populate mandal + booth dropdowns from the static booth list (no data fetch needed).
// Called every time the voter list tab becomes active — must be idempotent.
function initVoterListIfNeeded() {
  if (!canViewVoterList()) return;            // hard guard: admin only

  // Populate mandal/booth selects only on first visit (dropdowns already have content after that)
  if (!state.vlFiltersPopulated) {
    populateVlMandals();
    state.vlFiltersPopulated = true;
  }

  // Only reset to prompt view if no booth has been loaded yet
  if (!state.vlBoothData) {
    showVlPrompt();
  }
  // If booth data is already loaded, leave the table visible — don't reset
}

function populateVlMandals() {
  if (!els.vlMandal) return;
  const booths  = state.allBooths || [];
  const mandals = [...new Set(booths.map(b => String(b.mandal || '').trim()).filter(Boolean))].sort();
  els.vlMandal.innerHTML = '<option value="">All Mandals</option>' +
    mandals.map(m => `<option value="${m}">${m}</option>`).join('');
  populateVlBoothFilter('');
}

function populateVlBoothFilter(mandal) {
  if (!els.vlBooth) return;
  const all = state.allBooths || [];
  const src = mandal ? all.filter(b => String(b.mandal || '').trim() === mandal) : all;
  const sorted = src.slice().sort((a, b) => Number(a.booth) - Number(b.booth));
  els.vlBooth.innerHTML = '<option value="">— Select a Booth —</option>' +
    sorted.map(b => `<option value="${b.booth}">Booth ${b.booth} · ${b.village || ''}</option>`).join('');
}

function showVlPrompt() {
  if (els.vlLoading)    els.vlLoading.style.display    = 'none';
  if (els.vlError)      els.vlError.style.display      = 'none';
  if (els.vlTableWrap)  els.vlTableWrap.style.display  = 'none';
  if (els.vlSubFilters) els.vlSubFilters.style.display = 'none';
  if (els.vlPrompt)     els.vlPrompt.style.display     = 'block';
  if (els.vlStats)      els.vlStats.innerHTML          = '';
}

async function loadVlBooth(boothNo) {
  if (!canViewVoterList()) return;           // re-check: never fetch for non-admin
  if (!boothNo) { showVlPrompt(); return; }

  // Already loaded this booth — just re-apply filters
  if (state.vlLoadedBooth === boothNo && state.vlBoothData) {
    applyVlFilters();
    return;
  }

  if (els.vlPrompt)    els.vlPrompt.style.display    = 'none';
  if (els.vlError)     els.vlError.style.display     = 'none';
  if (els.vlTableWrap) els.vlTableWrap.style.display = 'none';
  if (els.vlLoading)   els.vlLoading.style.display   = 'block';
  if (els.vlLoading)   els.vlLoading.textContent     = `Loading Booth ${boothNo}…`;

  try {
    const res = await fetch(`voter_data/${boothNo}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    // raw = { booth, mandal, rows: [[sl,epic,name,relation,house,age,gender,deleted,phone,bjp], ...] }
    state.vlBoothData  = raw.rows.map(r => {
      const o = { booth: raw.booth, mandal: raw.mandal };
      VL_COLS.forEach((c, i) => { o[c] = r[i]; });
      return o;
    });
    state.vlLoadedBooth = boothNo;
    if (els.vlLoading)    els.vlLoading.style.display    = 'none';
    if (els.vlPrompt)     els.vlPrompt.style.display     = 'none';
    if (els.vlSubFilters) els.vlSubFilters.style.display = 'flex';
    applyVlFilters();
  } catch (err) {
    console.error('[VoterList] fetch failed for booth', boothNo, err);
    if (els.vlLoading) els.vlLoading.style.display = 'none';
    if (els.vlError) {
      els.vlError.textContent = `Failed to load Booth ${boothNo} data: ${err.message}`;
      els.vlError.style.display = 'block';
    }
    state.vlBoothData   = null;
    state.vlLoadedBooth = null;
  }
}

function applyVlFilters() {
  const data = state.vlBoothData;
  if (!data) return;
  const search  = (els.vlSearch?.value || '').trim().toLowerCase();
  const gender  = els.vlGender?.value  || '';
  const bjpOnly = els.vlBjp?.value === '1';

  state.vlFiltered = data.filter(r => {
    if (r.deleted === 'Y') return false;
    if (gender  && r.gender !== gender) return false;
    if (bjpOnly && !r.bjp) return false;
    if (search) {
      const hay = ((r.name||'') + ' ' + (r.epic||'') + ' ' + (r.house||'')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  state.vlPage = 1;
  renderVlStats();
  renderVlTable();
}

function renderVlStats() {
  if (!els.vlStats || !state.vlBoothData) return;
  const all  = state.vlBoothData.filter(r => r.deleted !== 'Y');
  const filt = state.vlFiltered;
  const bjp  = all.filter(r => r.bjp).length;
  const phone= all.filter(r => r.phone).length;
  els.vlStats.innerHTML = [
    ['Total in Booth', all.length.toLocaleString()],
    ['Filtered',       filt.length.toLocaleString()],
    ['BJP Members',    bjp.toLocaleString()],
    ['With Phone',     phone.toLocaleString()],
  ].map(([label, val]) =>
    `<div class="vl-stat"><span class="vl-stat-value">${val}</span><span class="vl-stat-label">${label}</span></div>`
  ).join('');
}

function renderVlTable() {
  if (!els.vlTableWrap || !els.vlBody) return;
  els.vlTableWrap.style.display = 'block';
  const filtered = state.vlFiltered;
  const total    = filtered.length;
  const pages    = Math.max(1, Math.ceil(total / VL_PAGE_SIZE));
  state.vlPage   = Math.min(state.vlPage, pages);
  const start    = (state.vlPage - 1) * VL_PAGE_SIZE;
  const slice    = filtered.slice(start, start + VL_PAGE_SIZE);

  if (els.vlResultBar) {
    els.vlResultBar.textContent = total
      ? `Showing ${start + 1}–${Math.min(start + VL_PAGE_SIZE, total)} of ${total.toLocaleString()} voters`
      : 'No voters match the current filters.';
  }

  els.vlBody.innerHTML = slice.map(r => {
    const isDeleted = r.deleted === 'Y';
    return `<tr class="${isDeleted ? 'vl-row-deleted' : ''}">
      <td>${r.sl}</td>
      <td style="font-family:monospace;font-size:11px">${r.epic || ''}</td>
      <td class="vl-name">${(r.name || '').toUpperCase()}</td>
      <td>${(r.relation || '').toUpperCase()}</td>
      <td>${r.house || ''}</td>
      <td>${r.age ?? ''}</td>
      <td>${r.gender || ''}</td>
      <td>${r.phone ? `<a href="tel:${r.phone}">${r.phone}</a>` : ''}</td>
      <td>${r.bjp ? '<span class="vl-bjp-badge">BJP</span>' : ''}</td>
      <td>${r.religion ? `<span class="vl-religion-badge vl-rel-${(r.religion||'').toLowerCase()}">${r.religion}</span>` : ''}</td>
    </tr>`;
  }).join('');

  renderVlPagination(pages);
}

function renderVlPagination(pages) {
  if (!els.vlPagination) return;
  if (pages <= 1) { els.vlPagination.innerHTML = ''; return; }
  els.vlPagination.innerHTML =
    `<button class="vl-page-btn" id="vlPrevBtn" ${state.vlPage === 1 ? 'disabled' : ''}>← Prev</button>
     <span class="vl-page-info">Page ${state.vlPage} of ${pages}</span>
     <button class="vl-page-btn" id="vlNextBtn" ${state.vlPage === pages ? 'disabled' : ''}>Next →</button>`;
  byId('vlPrevBtn')?.addEventListener('click', () => { state.vlPage--; renderVlTable(); });
  byId('vlNextBtn')?.addEventListener('click', () => { state.vlPage++; renderVlTable(); });
}

function printVoterList() {
  const data = state.vlBoothData;
  if (!data || !data.length) return;

  const boothNo  = state.vlLoadedBooth;
  const booth    = state.allBoothMap.get(Number(boothNo));
  const mandal   = booth?.mandal  || '';
  const village  = booth?.village || '';
  const title    = `AC 108 Udhagamandalam — Booth ${boothNo}${village ? ' · ' + village : ''}${mandal ? ' · ' + mandal : ''}`;

  const rows = data.map((r, i) => {
    const isDeleted = r.deleted === 'Y';
    const style = isDeleted
      ? 'color:#dc2626;text-decoration:line-through;'
      : (i % 2 === 0 ? 'background:#f9fafb;' : '');
    return `<tr style="${style}">
      <td style="padding:3px 6px;border:1px solid #ddd;white-space:nowrap">${r.sl}</td>
      <td style="padding:3px 6px;border:1px solid #ddd;font-family:monospace;font-size:11px">${r.epic || ''}</td>
      <td style="padding:3px 6px;border:1px solid #ddd;min-width:140px">${(r.name || '').toUpperCase()}</td>
      <td style="padding:3px 6px;border:1px solid #ddd">${(r.relation || '').toUpperCase()}</td>
      <td style="padding:3px 6px;border:1px solid #ddd">${r.house || ''}</td>
      <td style="padding:3px 6px;border:1px solid #ddd;text-align:center">${r.age ?? ''}</td>
      <td style="padding:3px 6px;border:1px solid #ddd">${r.gender || ''}</td>
      <td style="padding:3px 6px;border:1px solid #ddd">${r.phone || ''}</td>
      <td style="padding:3px 6px;border:1px solid #ddd;text-align:center">${r.bjp ? 'BJP' : ''}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; margin: 16px; color: #111; }
    h2   { font-size: 14px; margin: 0 0 4px; }
    p    { margin: 0 0 10px; font-size: 11px; color: #555; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #1e3a5f; color: #fff; padding: 4px 6px; border: 1px solid #1e3a5f; font-size: 11px; text-align: left; }
    @media print {
      @page { size: A4 landscape; margin: 10mm; }
      button { display: none; }
    }
  </style>
</head>
<body>
  <h2>${title}</h2>
  <p>Total voters: ${data.length} &nbsp;|&nbsp; Printed: ${new Date().toLocaleString('en-IN')}</p>
  <p style="color:#dc2626;font-size:10px">Deleted voters shown in red with strikethrough. &nbsp;|&nbsp; Proprietary data of BJP — Do not share.</p>
  <table>
    <thead>
      <tr>
        <th>Sl#</th><th>EPIC No</th><th>Voter Name</th><th>Relationship Name</th>
        <th>House</th><th>Age</th><th>Gender</th><th>Phone</th><th>BJP</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <script>window.onload = function(){ window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to print the voter list.'); return; }
  win.document.write(html);
  win.document.close();
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
  els.voterListTabBtn   = byId('voterListTabBtn');
  els.voterListSection  = byId('voterListSection');
  els.heatmapTabBtn     = byId('heatmapTabBtn');
  els.heatmapSection    = byId('heatmapSection');
  els.hmMandalBtns      = byId('hmMandalBtns');
  els.hmBoothBtns       = byId('hmBoothBtns');
  els.hmStats           = byId('hmStats');
  els.hmGrid            = byId('hmGrid');
  els.hmLegend          = byId('hmLegend');
  els.hmVotedFilterChk  = byId('hmVotedFilterChk');
  els.hmVotedReport     = byId('hmVotedReport');
  els.hmPrompt          = byId('hmPrompt');
  els.hmLoading         = byId('hmLoading');
  els.hmSaveStatus      = byId('hmSaveStatus');
  els.hmHeatmapView     = byId('hmHeatmapView');
  els.hmProgressView    = byId('hmProgressView');
  els.hmViewHeatmap     = byId('hmViewHeatmap');
  els.hmViewProgress    = byId('hmViewProgress');
  els.hmProgOverall      = byId('hmProgOverall');
  els.hmProgAlerts       = byId('hmProgAlerts');
  els.hmProgAnalytics    = byId('hmProgAnalytics');
  els.hmProgMandals      = byId('hmProgMandals');
  els.hmProgRefreshBtn   = byId('hmProgRefreshBtn');
  els.hmProgLastUpdated  = byId('hmProgLastUpdated');
  els.hmSectionHeading   = byId('hmSectionHeading');
  els.vlSearch          = byId('vlSearch');
  els.vlMandal          = byId('vlMandal');
  els.vlBooth           = byId('vlBooth');
  els.vlGender          = byId('vlGender');
  els.vlBjp             = byId('vlBjp');
  els.vlShowDeleted     = null; // removed from UI
  els.vlPrintBtn        = byId('vlPrintBtn');
  els.vlLoading         = byId('vlLoading');
  els.vlError           = byId('vlError');
  els.vlPrompt          = byId('vlPrompt');
  els.vlSubFilters      = byId('vlSubFilters');
  els.vlTableWrap       = byId('vlTableWrap');
  els.vlStats           = byId('vlStats');
  els.vlResultBar       = byId('vlResultBar');
  els.vlBody            = byId('vlBody');
  els.vlPagination      = byId('vlPagination');
  els.runDataRefreshBtn = byId('runDataRefreshBtn');
  els.dataRefreshStatus = byId('dataRefreshStatus');
  els.dataRefreshLog = byId('dataRefreshLog');
  els.dashboardScope = byId('dashboardScope');
  els.dashboardRefreshState = byId('dashboardRefreshState');
  els.dashboardSummary = byId('dashboardSummary');
  els.dashboardBoothList = byId('dashboardBoothList');
  els.dashboardBoothDetails = byId('dashboardBoothDetails');
  els.dashboardFilters = byId('dashboardFilters');
  els.dashboardMandalSelect = byId('dashboardMandalSelect');
  els.dashboardVillageSelect = byId('dashboardVillageSelect');
  els.dashboardStatusSelect = byId('dashboardStatusSelect');
  els.dashboardRefreshBtn = byId('dashboardRefreshBtn');
  els.mandalFilterGroup = byId('mandalFilterGroup');
  els.mandalSelect = byId('mandalSelect');
  els.villageFilterGroup = byId('villageFilterGroup');
  els.villageSelect = byId('villageSelect');
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
  if (els.villageSelect) els.villageSelect.addEventListener('change', onVillageChange);
  if (els.dashboardMandalSelect) els.dashboardMandalSelect.addEventListener('change', onDashboardMandalChange);
  if (els.dashboardVillageSelect) els.dashboardVillageSelect.addEventListener('change', onDashboardVillageChange);
  if (els.dashboardStatusSelect) els.dashboardStatusSelect.addEventListener('change', onDashboardStatusChange);
  if (els.dashboardRefreshBtn) els.dashboardRefreshBtn.addEventListener('click', onDashboardRefresh);
  if (els.boothSelect) els.boothSelect.addEventListener('change', onBoothChange);
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', logout);
  if (els.entryTabBtn) els.entryTabBtn.addEventListener('click', () => setActiveView('entry'));
  if (els.dashboardTabBtn) els.dashboardTabBtn.addEventListener('click', () => setActiveView('dashboard'));
  if (els.dataRefreshTabBtn) els.dataRefreshTabBtn.addEventListener('click', () => setActiveView('data-refresh'));
  if (els.voterListTabBtn)   els.voterListTabBtn.addEventListener('click', () => setActiveView('voter-list'));
  if (els.heatmapTabBtn)     els.heatmapTabBtn.addEventListener('click', () => setActiveView('heatmap'));
  if (els.hmViewHeatmap)     els.hmViewHeatmap.addEventListener('click', () => setHmView('heatmap'));
  if (els.hmViewProgress)    els.hmViewProgress.addEventListener('click', () => setHmView('progress'));
  if (els.hmProgRefreshBtn)  els.hmProgRefreshBtn.addEventListener('click', onHmProgRefresh);
  if (els.hmMandalBtns) els.hmMandalBtns.addEventListener('click', e => {
    const btn = e.target.closest('.hm-mandal-btn');
    if (!btn) return;
    els.hmMandalBtns.querySelectorAll('.hm-mandal-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (els.hmBoothBtns) els.hmBoothBtns.querySelectorAll('.hm-booth-btn').forEach(b => b.classList.remove('active'));
    renderHmBoothButtons(btn.dataset.mandal);
    showHmPrompt('Select a booth above to load the heatmap.');
  });
  if (els.hmBoothBtns) els.hmBoothBtns.addEventListener('click', e => {
    const btn = e.target.closest('.hm-booth-btn');
    if (!btn) return;
    els.hmBoothBtns.querySelectorAll('.hm-booth-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadHeatmapBooth(btn.dataset.booth);
  });
  if (els.hmGrid) els.hmGrid.addEventListener('click', e => {
    const cell = e.target.closest('.hm-cell');
    if (cell) onHeatmapCellClick(cell);
  });
  if (els.runDataRefreshBtn) els.runDataRefreshBtn.addEventListener('click', onManualDataRefresh);
  if (els.hmVotedFilterChk) els.hmVotedFilterChk.addEventListener('change', renderHmVotedReport);

  // Mandal perf card click → show booth detail table
  if (els.hmProgAlerts) {
    els.hmProgAlerts.addEventListener('click', e => {
      const closeBtn = e.target.closest('.hm-dt-close');
      if (closeBtn) {
        if (els.hmProgMandals) els.hmProgMandals.innerHTML = '';
        document.querySelectorAll('.hm-perf-card--active').forEach(c => c.classList.remove('hm-perf-card--active'));
        return;
      }
      const card = e.target.closest('.hm-perf-card[data-mandal]');
      if (!card) return;
      document.querySelectorAll('.hm-perf-card--active').forEach(c => c.classList.remove('hm-perf-card--active'));
      card.classList.add('hm-perf-card--active');
      renderHmBoothDetailTable(card.dataset.mandal);
    });
  }

  // Voter list filter listeners
  const vlFilterChange = () => applyVlFilters();
  if (els.vlMandal) els.vlMandal.addEventListener('change', () => {
    populateVlBoothFilter(els.vlMandal.value);
    if (els.vlBooth) els.vlBooth.value = '';
    showVlPrompt();                            // booth deselected — clear table
  });
  if (els.vlBooth) els.vlBooth.addEventListener('change', () => {
    state.vlPage = 1;
    loadVlBooth(els.vlBooth.value);           // fetch only this booth
  });
  if (els.vlSearch)  els.vlSearch.addEventListener('input',  vlFilterChange);
  if (els.vlGender)  els.vlGender.addEventListener('change', vlFilterChange);
  if (els.vlBjp)     els.vlBjp.addEventListener('change',   vlFilterChange);
  if (els.vlPrintBtn)els.vlPrintBtn.addEventListener('click', printVoterList);

  // Delegated listeners on votersContainer — survive innerHTML replacement in renderVoters()
  if (els.votersContainer) {
    els.votersContainer.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      if (btn.id === 'prevPageBtn') { changePage(-1); return; }
      if (btn.id === 'nextPageBtn') { changePage(1); return; }
      if (btn.id === 'submitAffinityBtn') { onSaveBooth(); return; }
      if (btn.id === 'clearInputBtn') { onClearBoothData(); return; }
      if (btn.classList.contains('affinity-btn')) {
        onAffinityClick({ target: btn });
      }
    });
    els.votersContainer.addEventListener('change', e => {
      const input = e.target;
      if (!input) return;
      if (input.id === 'pendingVotersChk') {
        state.pendingVotersFilter = input.checked;
        state.currentPage = 1;
        renderVoters();
      } else if (input.classList.contains('voter-flag-input')) {
        onVoterFlagChange(e);
      }
    });
  }

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

// ── Heatmap view toggle ───────────────────────────────────────────────────────
function setHmView(view) {
  state.hmActiveView = view;
  const isHeatmap = view === 'heatmap';
  if (els.hmHeatmapView)  els.hmHeatmapView.style.display  = isHeatmap ? 'block' : 'none';
  if (els.hmProgressView) els.hmProgressView.style.display = isHeatmap ? 'none'  : 'block';
  if (els.hmViewHeatmap)  els.hmViewHeatmap.classList.toggle('active', isHeatmap);
  if (els.hmViewProgress) els.hmViewProgress.classList.toggle('active', !isHeatmap);
  if (els.hmProgRefreshBtn) els.hmProgRefreshBtn.style.display = isHeatmap ? 'none' : '';
  if (els.hmSectionHeading) els.hmSectionHeading.textContent = isHeatmap
    ? 'Voted Heatmap — வாக்களித்தவர் வரைபடம்'
    : 'Voting Progress — வாக்களிப்பு முன்னேற்றம்';
  if (!isHeatmap) renderHmProgressView();
}

// ── Voting Progress dashboard ─────────────────────────────────────────────────
function getHmProgressData() {
  const allBooths = state.allBooths || [];
  const mandalMap = {};

  allBooths.forEach(b => {
    const boothNo = Number(b.booth);
    const total   = Number(b.totalVoters) || 0;
    const cache   = state.pageCache[boothNo];
    // Read voted only from hmVotedBooths — never from background dashboard refresh
    const voted   = Number(state.hmVotedBooths[boothNo] ?? 0);
    const summary = cache?.summary || { A:0, B:0, C:0, D:0, E:0 };
    const A = Number(summary.A||0), Bv = Number(summary.B||0),
          C = Number(summary.C||0), D  = Number(summary.D||0), E = Number(summary.E||0);
    const tagged   = A + Bv + C + D + E;
    const nda      = A + Bv;           // committed BJP+NDA voters
    const mandal   = String(b.mandal || '').trim() || 'Unknown';
    const loaded   = !!cache;

    if (!mandalMap[mandal]) mandalMap[mandal] = {
      total:0, voted:0, A:0, B:0, C:0, D:0, E:0, nda:0, tagged:0, booths:[], loadedCount:0
    };
    const mm = mandalMap[mandal];
    mm.total  += total;  mm.voted  += voted;
    mm.A += A; mm.B += Bv; mm.C += C; mm.D += D; mm.E += E;
    mm.nda    += nda;    mm.tagged += tagged;
    mm.loadedCount += loaded ? 1 : 0;
    mm.booths.push({ boothNo, name: b.village||'', total, voted, A, B:Bv, C, D, E, nda, tagged, loaded });
  });

  const overall = { total:0, voted:0, A:0, B:0, C:0, D:0, E:0, nda:0, tagged:0 };
  Object.values(mandalMap).forEach(m => {
    overall.total  += m.total;  overall.voted  += m.voted;
    overall.A += m.A; overall.B += m.B; overall.C += m.C;
    overall.D += m.D; overall.E += m.E;
    overall.nda    += m.nda;    overall.tagged += m.tagged;
  });
  return { overall, mandalMap };
}


function calcProjectedBJP(A, B, C, D, E) {
  return Math.round((A || 0) * 1.0 + (B || 0) * 0.8 + (C || 0) * 0.55 + (D || 0) * 0.20);
}

function hmProgressBar(pct, extraClass = '') {
  const p = Math.min(100, Math.max(0, pct));
  const color = p >= 60 ? '#2e7d32' : p >= 30 ? '#f57c00' : '#c62828';
  return `<div class="hm-prog-bar-wrap${extraClass ? ' ' + extraClass : ''}">
    <div class="hm-prog-bar-fill" style="width:${p}%;background:${color};"></div>
  </div>`;
}

function hmTurnoutClass(pct) {
  return pct >= 60 ? 'hm-turn-good' : pct >= 30 ? 'hm-turn-warn' : 'hm-turn-bad';
}

function hmAbcdeRow(A, B, C, D, E, tagged) {
  if (!tagged) return '<span class="hm-abcde-none">Not tagged</span>';
  return `<span class="hm-ab-chip hm-ab-a">A ${A}</span>` +
         `<span class="hm-ab-chip hm-ab-b">B ${B}</span>` +
         `<span class="hm-ab-chip hm-ab-c">C ${C}</span>` +
         `<span class="hm-ab-chip hm-ab-d">D ${D}</span>` +
         `<span class="hm-ab-chip hm-ab-e">E ${E}</span>`;
}

// Returns status colour for a mandal header based on 2021 performance + current composition
// Green=Sure Win/Likely Win, Amber=Swing, Red=Tough Fight
// Strong past performance always shows green; composition only modulates shade
function hmMandalStatus(won, lost, A, B, E) {
  const totalBooths = won + lost;
  const perfScore  = totalBooths > 0 ? (won - lost) / totalBooths : 0; // -1 to +1
  const ndaVsOpp   = A + B + E;
  const compScore  = ndaVsOpp  > 0 ? ((A + B) - E) / ndaVsOpp  : 0; // -1 to +1

  if (perfScore > 0.3) {
    // Historically strong — never red
    if (compScore >= 0)
      return { bg: 'linear-gradient(135deg,#1b5e20,#2e7d32)', text: '#fff', label: 'Sure Win',   solid: '#2e7d32' };
    // Good history but composition uncertain → lighter green
    return   { bg: 'linear-gradient(135deg,#43a047,#81c784)', text: '#fff', label: 'Likely Win', solid: '#43a047' };
  }

  const score = perfScore * 0.6 + compScore * 0.4;
  if (score > 0.1)  return { bg: 'linear-gradient(135deg,#1b5e20,#2e7d32)', text: '#fff', label: 'Sure Win',    solid: '#2e7d32' };
  if (score < -0.1) return { bg: 'linear-gradient(135deg,#b71c1c,#c62828)', text: '#fff', label: 'Tough Fight', solid: '#c62828' };
  return               { bg: 'linear-gradient(135deg,#bf360c,#e65100)',       text: '#fff', label: 'Swing',       solid: '#e65100' };
}

// SVG donut showing A/B/C/D/E voter composition
function hmAbcdeDonut(A, B, C, D, E, size) {
  const total = A + B + C + D + E;
  const sz = size || 72;
  const r = sz * 0.36, cx = sz / 2, cy = sz / 2;
  const circ = 2 * Math.PI * r;
  const segs = [
    { v: A, c: '#1565c0', l: 'A' },
    { v: B, c: '#2e7d32', l: 'B' },
    { v: C, c: '#e65100', l: 'C' },
    { v: D, c: '#6a1b9a', l: 'D' },
    { v: E, c: '#c62828', l: 'E' },
  ];
  if (total === 0) {
    return `<svg class="hm-donut-svg" viewBox="0 0 ${sz} ${sz}">
      <circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="#e0e0e0" stroke-width="${sz*0.17}"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dy="0.35em" class="hm-donut-total">—</text>
    </svg>`;
  }
  let acc = 0;
  const circles = segs.filter(s => s.v > 0).map(s => {
    const len = (s.v / total) * circ;
    const dashoffset = (circ * 0.25) - acc;
    acc += len;
    return `<circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="${s.c}"
      stroke-width="${sz*0.17}" stroke-dasharray="${len.toFixed(2)} ${(circ-len).toFixed(2)}"
      stroke-dashoffset="${dashoffset.toFixed(2)}"/>`;
  });
  return `<svg class="hm-donut-svg" viewBox="0 0 ${sz} ${sz}" xmlns="http://www.w3.org/2000/svg">
    <circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="#eee" stroke-width="${sz*0.17}"/>
    ${circles.join('')}
    <text x="${cx}" y="${cy}" text-anchor="middle" dy="0.35em" class="hm-donut-total">${total}</text>
  </svg>`;
}

// A/B/C grade based on 2021 margin vs INC: A=won>10%(green), B=±10%(amber), C=lost>10%(red)
function hmMarginGradeBadge(cfg) {
  const m = cfg?.marginVsInc;
  if (m === null || m === undefined) return '—';
  if (m > 0.10)  return `<span class="hm-br-badge hm-mg-a" title="Won by ${(m*100).toFixed(1)}% in 2021">A</span>`;
  if (m >= -0.10) return `<span class="hm-br-badge hm-mg-b" title="${m>=0?'+':''}${(m*100).toFixed(1)}% margin in 2021">B</span>`;
  return                 `<span class="hm-br-badge hm-mg-c" title="Lost by ${Math.abs(m*100).toFixed(1)}% in 2021">C</span>`;
}

function hmBoothRatingBadge(boothNo) {
  const cfg = state.allBoothMap.get(Number(boothNo));
  const r = String(cfg?.boothRating || '').toUpperCase();
  if (!r) return '';
  const tip = cfg?.boothGrade || r;
  return `<span class="hm-br-badge hm-br-${r.toLowerCase()}" title="${tip}">${r}</span>`;
}

// Insights from Booth Entry for a given booth: tagging completion + NDA strength
function hmBoothEntryInsights(boothNo, totalVoters) {
  const cache   = state.pageCache[Number(boothNo)];
  const summary = cache?.summary || {};
  const A = Number(summary.A || 0), B = Number(summary.B || 0),
        C = Number(summary.C || 0), D = Number(summary.D || 0),
        E = Number(summary.E || 0);
  const tagged   = A + B + C + D + E;
  const taggedPct = totalVoters > 0 ? (tagged / totalVoters) * 100 : 0;
  const ndaStrength = tagged > 0 ? ((A + B) / tagged) * 100 : 0;
  return { tagged, taggedPct, ndaStrength, A, B, C, D, E };
}

// Colour palette for mandal tab headers (cycles by index)
const HM_MANDAL_COLORS = [
  { bg: 'linear-gradient(90deg,#1565c0,#1976d2)', text: '#fff', solid: '#1565c0' },
  { bg: 'linear-gradient(90deg,#2e7d32,#388e3c)', text: '#fff', solid: '#2e7d32' },
  { bg: 'linear-gradient(90deg,#6a1b9a,#7b1fa2)', text: '#fff', solid: '#6a1b9a' },
  { bg: 'linear-gradient(90deg,#e65100,#f57c00)', text: '#fff', solid: '#e65100' },
  { bg: 'linear-gradient(90deg,#00695c,#00897b)', text: '#fff', solid: '#00695c' },
  { bg: 'linear-gradient(90deg,#ad1457,#c2185b)', text: '#fff', solid: '#ad1457' },
  { bg: 'linear-gradient(90deg,#283593,#3949ab)', text: '#fff', solid: '#283593' },
  { bg: 'linear-gradient(90deg,#4e342e,#6d4c41)', text: '#fff', solid: '#4e342e' },
];

function setHmProgMandal(name) {
  state.hmProgActiveMandal = name;
  // Swap tab active styles without full re-render
  document.querySelectorAll('.hm-mandal-tab').forEach(t => {
    const on = t.dataset.mandal === name;
    t.classList.toggle('active', on);
    t.style.background = on ? t.dataset.bg : '';
    t.style.color      = on ? '#fff' : '';
    t.style.borderBottomColor = on ? 'transparent' : t.dataset.solid;
  });
  document.querySelectorAll('.hm-mandal-tab-panel').forEach(p => {
    p.style.display = p.dataset.mandal === name ? '' : 'none';
  });
}

// Shared helper — renders mandal tabs + panels into els.hmProgMandals
// mandalRows: [[name, md], ...]  sorted by caller
// tabMetaFn(mandal, md, idx) → { metric, subtext, ndaBadge }
// boothCardsFn(md) → HTML string of booth cards
function hmRenderMandalTabs(mandalRows, tabMetaFn, boothCardsFn) {
  // Preserve or default active mandal
  const names = mandalRows.map(([m]) => m);
  if (!names.includes(state.hmProgActiveMandal)) {
    state.hmProgActiveMandal = names[0] || null;
  }
  const active = state.hmProgActiveMandal;

  const tabs = mandalRows.map(([mandal, md], idx) => {
    const palette = HM_MANDAL_COLORS[idx % HM_MANDAL_COLORS.length];
    const { metric, subtext } = tabMetaFn(mandal, md, idx);
    const on = mandal === active;
    const inlineStyle = on
      ? `background:${palette.bg};color:#fff;border-bottom-color:transparent;`
      : `border-bottom-color:${palette.solid};`;
    return `<button class="hm-mandal-tab${on ? ' active' : ''}"
      data-mandal="${mandal.replace(/"/g,'&quot;')}"
      data-bg="${palette.bg.replace(/"/g,'&quot;')}"
      data-solid="${palette.solid}"
      onclick="setHmProgMandal(this.dataset.mandal)"
      style="${inlineStyle}">
      <span class="hm-mandal-tab-name">${mandal}</span>
      <span class="hm-mandal-tab-metric">${metric}</span>
      ${subtext ? `<span class="hm-mandal-tab-sub">${subtext}</span>` : ''}
    </button>`;
  }).join('');

  const panels = mandalRows.map(([mandal, md], idx) => {
    const palette = HM_MANDAL_COLORS[idx % HM_MANDAL_COLORS.length];
    const { panelBar, panelStats, ndaBadge } = tabMetaFn(mandal, md, idx);
    const on = mandal === active;
    return `<div class="hm-mandal-tab-panel" data-mandal="${mandal.replace(/"/g,'&quot;')}"
        style="${on ? '' : 'display:none'}">
      <div class="hm-mandal-panel-header" style="border-left:4px solid ${palette.solid}">
        <div class="hm-mandal-panel-header-top">
          <span class="hm-mandal-panel-name">${mandal}</span>
          <div class="hm-mandal-panel-badges">${ndaBadge}</div>
        </div>
        ${panelBar}
        <div class="hm-mandal-panel-stats">${panelStats}</div>
      </div>
      <div class="hm-prog-booths-wrap">${boothCardsFn(md)}</div>
    </div>`;
  }).join('');

  if (els.hmProgMandals) {
    els.hmProgMandals.innerHTML = `
      <div class="hm-mandal-tabs">${tabs}</div>
      <div class="hm-mandal-tab-panels">${panels}</div>`;
  }
}

// Segmented ABCDE proportion bar
function hmSegBar(A, B, C, D, E, total) {
  if (!total) return '<div class="hm-seg-bar hm-seg-bar--empty"></div>';
  const segs = [
    { val: A, cls: 'hm-seg-a', label: 'A' },
    { val: B, cls: 'hm-seg-b', label: 'B' },
    { val: C, cls: 'hm-seg-c', label: 'C' },
    { val: D, cls: 'hm-seg-d', label: 'D' },
    { val: E, cls: 'hm-seg-e', label: 'E' },
  ];
  const tagged = A + B + C + D + E;
  const untagged = Math.max(0, total - tagged);
  const parts = segs.filter(s => s.val > 0).map(s => {
    const w = ((s.val / total) * 100).toFixed(2);
    return `<div class="hm-seg-part ${s.cls}" style="width:${w}%" title="${s.label}: ${s.val}"></div>`;
  });
  if (untagged > 0) {
    const w = ((untagged / total) * 100).toFixed(2);
    parts.push(`<div class="hm-seg-part hm-seg-u" style="width:${w}%" title="Untagged: ${untagged}"></div>`);
  }
  return `<div class="hm-seg-bar">${parts.join('')}</div>`;
}

// SVG ring (donut) for a percentage
function hmRing(pct, color = '#f97316', size = 56) {
  const p = Math.min(100, Math.max(0, pct));
  const r = 22, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = (p / 100) * circ;
  return `<svg class="hm-ring-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eee" stroke-width="6"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="6"
      stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}"
      stroke-dashoffset="${(circ / 4).toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
      class="hm-ring-label" fill="${color}">${p.toFixed(0)}%</text>
  </svg>`;
}

function renderHmProgressView() {
  if (!els.hmProgOverall || !els.hmProgMandals) return;

  if (els.hmProgLastUpdated) {
    els.hmProgLastUpdated.textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Auto-fetch all booth affinity data on first open so tiles show real tagging counts
  if (!state.hmProgAutoRefreshed && !state.hmProgLoading) {
    state.hmProgAutoRefreshed = true;
    onHmProgRefresh();
    return; // onHmProgRefresh calls renderHmProgressView() when done
  }

  renderHmNdaView();
}

function renderHmNdaView() {
  const { overall, mandalMap } = getHmProgressData();
  const overallPct    = overall.total ? (overall.voted / overall.total) * 100 : 0;
  const overallPctStr = overallPct.toFixed(1);
  const ndaGap        = Math.max(0, overall.nda - overall.voted);
  const ndaMobilised  = overall.nda > 0 && overall.voted >= overall.nda;
  const ringColor     = overallPct >= 60 ? '#2e7d32' : overallPct >= 30 ? '#f57c00' : '#c62828';

  // Computed once; used in both the hero mandal summary and the tabs below
  const mandalRows = Object.entries(mandalMap).sort((a, b) => {
    const aPct = a[1].total ? a[1].voted / a[1].total : 0;
    const bPct = b[1].total ? b[1].voted / b[1].total : 0;
    return aPct - bPct; // worst turnout first
  });

  els.hmProgOverall.innerHTML = `
    <div class="hm-prog-hero">

      <!-- ── 3 top-level stat cards ── -->
      <div class="hm-top-cards">
        <div class="hm-top-card hm-top-card--votes">
          <div class="hm-top-card-label">Total Votes Cast</div>
          <div class="hm-top-card-val">${overall.voted.toLocaleString('en-IN')}</div>
          <div class="hm-top-card-sub">of ${overall.total.toLocaleString('en-IN')} enrolled</div>
          ${hmProgressBar(overallPct, 'hm-prog-bar--hero')}
        </div>
        <div class="hm-top-card hm-top-card--pct">
          <div class="hm-top-card-label">Turnout</div>
          <div class="hm-top-card-val ${hmTurnoutClass(overallPct)}">${overallPctStr}%</div>
          <div class="hm-top-card-sub">AC 108 · Overall</div>
          ${hmRing(overallPct, ringColor, 60)}
        </div>
        <div class="hm-top-card hm-top-card--bjp">
          <div class="hm-top-card-label">Projected BJP Votes</div>
          <div class="hm-top-card-val hm-bjp-proj-val">${calcProjectedBJP(overall.A, overall.B, overall.C, overall.D, overall.E).toLocaleString('en-IN')}</div>
          <div class="hm-top-card-sub">A×1.0 + B×0.8 + C×0.55 + D×0.20</div>
          <div class="hm-bjp-proj-abcd">
            <span title="A — confirmed BJP">A <b>${overall.A}</b></span>
            <span title="B — NDA allied">B <b>${overall.B}</b></span>
            <span title="C — sympathiser">C <b>${overall.C}</b></span>
            <span title="D — undecided">D <b>${overall.D}</b></span>
            <span title="E — opposition">E <b>${overall.E}</b></span>
          </div>
        </div>
      </div>

      <!-- ── 1 tile per mandal (3 per row) ── -->
      <div class="hm-mandal-tiles">
        ${mandalRows.map(([mandal, md]) => {
          const mPct  = md.total ? (md.voted / md.total) * 100 : 0;
          const mCls  = hmTurnoutClass(mPct);
          const ndaOk = md.nda > 0 && md.voted >= md.nda;
          // compute won/lost for this mandal from V6 ratings
          let mWon = 0, mLost = 0;
          md.booths.forEach(b => {
            const r = String(state.allBoothMap.get(Number(b.boothNo))?.boothRating || '').toUpperCase();
            if (['A','B','C'].includes(r)) mWon++;
            else if (['D','E','F'].includes(r)) mLost++;
          });
          const status = hmMandalStatus(mWon, mLost, md.A, md.B, md.E);
          return `<div class="hm-mt" style="border-top:3px solid ${status.solid}">
            <div class="hm-mt-hdr" style="background:${status.bg};color:${status.text}">
              <span class="hm-mt-name">${mandal} <span class="hm-mt-booth-count">${md.booths.length}</span></span>
              <span class="hm-mt-status-lbl">${status.label}</span>
            </div>
            <div class="hm-mt-body">
              ${hmProgressBar(mPct, 'hm-prog-bar--booth')}
              <div class="hm-mt-row">
                <span class="hm-mt-pct ${mCls}">${mPct.toFixed(1)}%</span>
                <span class="hm-mt-nums">${md.voted.toLocaleString('en-IN')} / ${md.total.toLocaleString('en-IN')}</span>
              </div>
              ${md.nda ? `<div class="hm-mt-nda ${ndaOk ? 'hm-mt-nda--ok' : ''}">NDA ${md.nda.toLocaleString('en-IN')}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>

      <!-- ── NDA mobilisation status ── -->
      <div class="hm-prog-nda-strip ${ndaMobilised ? 'hm-nda-ok' : 'hm-nda-pending'}">
        ${ndaMobilised
          ? `✓ All NDA committed voters mobilised`
          : `NDA Gap: <strong>${ndaGap.toLocaleString('en-IN')}</strong> committed voters yet to vote`}
      </div>
    </div>`;

  // ── Per-mandal past performance summary ─────────────────────────────────────
  if (els.hmProgAlerts) {
    const perfCards = mandalRows.map(([mandal, md]) => {
      const booths  = md.booths;

      // Grade breakdown from V6 boothRating; BJP 2021 votes = nda2021 × totalVoters × poll2021
      let won = 0, lost = 0, margins = [], bjpVoteCount = 0, bjpShareSum = 0, bjpWeightTotal = 0;
      booths.forEach(b => {
        const cfg = state.allBoothMap.get(Number(b.boothNo)) || {};
        const r = String(cfg.boothRating || '').toUpperCase();
        if (['A','B','C'].includes(r)) won++;
        if (['D','E','F'].includes(r)) lost++;
        if (cfg.marginVsInc !== null && cfg.marginVsInc !== undefined) margins.push(cfg.marginVsInc);
        if (cfg.nda2021 != null && cfg.totalVoters) {
          const polled = cfg.poll2021 != null ? cfg.poll2021 : 1;
          bjpVoteCount  += Math.round(cfg.nda2021 * cfg.totalVoters * polled);
          bjpShareSum    += cfg.nda2021 * cfg.totalVoters;
          bjpWeightTotal += cfg.totalVoters;
        }
      });
      const avgMargin    = margins.length ? margins.reduce((s, v) => s + v, 0) / margins.length : null;
      const avgMarginPct = avgMargin !== null ? (avgMargin * 100).toFixed(1) : null;
      const avgBjpShare  = bjpWeightTotal > 0 ? ((bjpShareSum / bjpWeightTotal) * 100).toFixed(1) : null;

      // NDA committed from affinity
      const ndaComm = md.A + md.B;
      const ndaTagged = md.tagged;
      const ndaStrPct = ndaTagged > 0 ? Math.round((ndaComm / ndaTagged) * 100) : 0;

      // Turnout status
      const mPct = md.total ? (md.voted / md.total) * 100 : 0;
      const mCls = hmTurnoutClass(mPct);

      const status = hmMandalStatus(won, lost, md.A, md.B, md.E);

      // Mobilisation bar: votes cast today vs NDA committed target
      const mobPct    = md.nda > 0 ? Math.min(100, (md.voted / md.nda) * 100) : 0;
      const mobCls    = mobPct >= 100 ? 'hm-mob-ok' : mobPct >= 60 ? 'hm-mob-mid' : 'hm-mob-low';
      const mobExcess = md.nda > 0 && md.voted > md.nda;

      return `<div class="hm-perf-card" data-mandal="${mandal.replace(/"/g,'&quot;')}" style="border-top:3px solid ${status.solid}; cursor:pointer;">
        <div class="hm-perf-mandal" style="background:${status.bg};color:${status.text}">
          <span>${mandal} <span class="hm-perf-booth-count">No. of Booths: ${booths.length}</span></span>
          <span class="hm-perf-status-badge">${status.label}</span>
        </div>
        <div class="hm-perf-body">

          <!-- Past Performance tile -->
          <div class="hm-perf-section-lbl">Past Performance</div>
          <div class="hm-pp-tile">
            <div class="hm-pp-stat hm-perf-won" title="Booths won in 2021">
              <span class="hm-pp-val">${won}</span>
              <span class="hm-pp-lbl">Won</span>
            </div>
            <div class="hm-pp-stat hm-perf-lost" title="Booths lost in 2021">
              <span class="hm-pp-val">${lost}</span>
              <span class="hm-pp-lbl">Lost</span>
            </div>
            ${avgMarginPct !== null ? `<div class="hm-pp-stat ${Number(avgMarginPct) >= 0 ? 'hm-perf-margin-pos':'hm-perf-margin-neg'}"
                title="Avg BJP margin vs INC in 2021">
              <span class="hm-pp-val">${Number(avgMarginPct) >= 0 ? '+' : ''}${avgMarginPct}%</span>
              <span class="hm-pp-lbl">Avg Margin</span>
            </div>` : ''}
            ${avgBjpShare !== null ? `<div class="hm-pp-stat hm-pp-bjp" title="BJP/NDA votes in 2021 (share × total voters × turnout)">
              <span class="hm-pp-val">${bjpVoteCount.toLocaleString('en-IN')}</span>
              <span class="hm-pp-val hm-pp-val--sub">${avgBjpShare}%</span>
              <span class="hm-pp-lbl">BJP Votes 2021</span>
            </div>` : ''}
          </div>

          <!-- Projected BJP Votes from tagging -->
          <div class="hm-perf-section-lbl">Projected BJP Votes</div>
          <div class="hm-pp-tile hm-pp-tile--bjp">
            <div class="hm-pp-stat hm-pp-bjp-proj" title="A×1.0 + B×0.8 + C×0.55 + D×0.20">
              <span class="hm-pp-val hm-bjp-proj-val">${calcProjectedBJP(md.A, md.B, md.C, md.D, md.E).toLocaleString('en-IN')}</span>
              <span class="hm-pp-lbl">Projected</span>
            </div>
            <div class="hm-pp-stat" title="A — confirmed BJP">
              <span class="hm-pp-val">${md.A}</span><span class="hm-pp-lbl hm-pp-lbl--a">A ×1.0</span>
            </div>
            <div class="hm-pp-stat" title="B — NDA allied">
              <span class="hm-pp-val">${md.B}</span><span class="hm-pp-lbl hm-pp-lbl--b">B ×0.8</span>
            </div>
            <div class="hm-pp-stat" title="C — sympathiser">
              <span class="hm-pp-val">${md.C}</span><span class="hm-pp-lbl hm-pp-lbl--c">C ×0.55</span>
            </div>
            <div class="hm-pp-stat" title="D — undecided">
              <span class="hm-pp-val">${md.D}</span><span class="hm-pp-lbl hm-pp-lbl--d">D ×0.20</span>
            </div>
          </div>

          <!-- Voter Composition stacked bar -->
          <div class="hm-perf-section-lbl">Voter Composition (Tagged)</div>
          ${hmSegBar(md.A, md.B, md.C, md.D, md.E, md.total)}
          <div class="hm-comp-legend">
            <span><span class="hm-seg-dot hm-seg-a"></span>A ${md.A}</span>
            <span><span class="hm-seg-dot hm-seg-b"></span>B ${md.B}</span>
            <span><span class="hm-seg-dot hm-seg-c"></span>C ${md.C}</span>
            <span><span class="hm-seg-dot hm-seg-d"></span>D ${md.D}</span>
            <span><span class="hm-seg-dot hm-seg-e"></span>E ${md.E}</span>
            <span class="hm-comp-nda-pct">${ndaStrPct}% NDA</span>
          </div>

          <!-- Mobilisation bar: votes cast vs NDA committed (only if tagged NDA voters exist) -->
          ${md.nda > 0 ? `
          <div class="hm-perf-section-lbl hm-perf-section-lbl--mob">Today vs Committed</div>
          <div class="hm-mob-bar-wrap">
            <div class="hm-mob-bar">
              ${mobPct > 0 ? `<div class="hm-mob-fill ${mobCls}" style="width:${mobPct.toFixed(1)}%"></div>` : ''}
            </div>
            <div class="hm-mob-nums">
              <span>${md.voted.toLocaleString('en-IN')} voted</span>
              <span class="hm-mob-target ${mobCls}">/ ${md.nda.toLocaleString('en-IN')} committed ${mobExcess ? '✓' : mobPct.toFixed(0)+'%'}</span>
            </div>
          </div>` : ''}

          <!-- Live today -->
          <div class="hm-perf-row hm-perf-row--footer">
            <span class="hm-perf-today ${mCls}">${mPct.toFixed(1)}% overall turnout</span>
          </div>
        </div>
      </div>`;
    });
    els.hmProgAlerts.innerHTML = `<div class="hm-perf-grid">${perfCards.join('')}</div>`;
  }

  // ── Mandal tabs (NDA view — mandalRows already sorted above) ────────────────
  // Tabs removed — booth details shown in table on card click (see renderHmBoothDetailTable)
  if (els.hmProgMandals) els.hmProgMandals.innerHTML = '';

  renderHmAnalytics();
}

function renderHmAnalytics() {
  if (!els.hmProgAnalytics) return;
  const allBooths = state.allBooths || [];
  if (!allBooths.length) { els.hmProgAnalytics.innerHTML = ''; return; }

  // Build per-booth analytics rows
  const rows = allBooths.map(b => {
    const boothNo    = Number(b.booth);
    const total      = Number(b.totalVoters) || 0;
    const voted      = Number(state.hmVotedBooths[boothNo] ?? 0);
    const turnoutPct = total ? (voted / total) * 100 : 0;
    const minority   = (Number(b.rChristian || 0) + Number(b.rMuslim || 0));
    const minPct     = total ? (minority / total) * 100 : 0;
    const cache      = state.pageCache[boothNo];
    const vs         = cache?.votedSummary || { A:0, B:0, C:0, D:0, E:0 };
    return { boothNo, village: b.village || '', mandal: b.mandal || '', total, voted, turnoutPct, minority, minPct, vs };
  }).filter(r => r.total > 0);

  const TOP_N = 15;
  const loaded = rows.filter(r => state.pageCache[r.boothNo] || r.voted > 0);

  const highTurnout  = [...loaded].sort((a, b) => b.turnoutPct - a.turnoutPct).slice(0, TOP_N);
  const lowTurnout   = [...loaded].sort((a, b) => a.turnoutPct - b.turnoutPct).slice(0, TOP_N);
  const highMinority = [...rows].sort((a, b) => b.minPct - a.minPct).slice(0, TOP_N);

  const vsBar = (vs) => {
    const total = vs.A + vs.B + vs.C + vs.D + vs.E;
    if (!total) return '';
    return `<div class="hm-an-vs-row">
      ${['A','B','C','D','E'].map(k => vs[k] > 0
        ? `<span class="hm-an-vs-chip hm-an-vs-${k.toLowerCase()}" title="${k}: ${vs[k]} voted">${k}<b>${vs[k]}</b></span>`
        : '').join('')}
    </div>`;
  };

  const boothCard = (r, metricHtml, badgeClass) => `
    <div class="hm-an-card ${badgeClass}">
      <div class="hm-an-booth">#${r.boothNo}</div>
      <div class="hm-an-village">${r.village}</div>
      <div class="hm-an-mandal">${r.mandal}</div>
      ${metricHtml}
      ${vsBar(r.vs)}
    </div>`;

  const turnoutMetric = (r) => {
    const cls = r.turnoutPct >= 60 ? 'hm-an-val--green' : r.turnoutPct >= 30 ? 'hm-an-val--amber' : 'hm-an-val--red';
    return `<div class="hm-an-metric">
      <span class="hm-an-val ${cls}">${r.turnoutPct.toFixed(1)}%</span>
      <span class="hm-an-sub">${r.voted}/${r.total} voted</span>
    </div>`;
  };

  const minorityMetric = (r) => {
    const turnCls = r.turnoutPct >= 60 ? 'hm-an-val--green' : r.turnoutPct >= 30 ? 'hm-an-val--amber' : 'hm-an-val--red';
    return `<div class="hm-an-metric">
      <span class="hm-an-val hm-an-val--purple">${r.minPct.toFixed(1)}%</span>
      <span class="hm-an-sub">Chr+Mus · ${r.minority} voters</span>
      <span class="hm-an-sub">Turnout: <span class="${turnCls}">${r.turnoutPct.toFixed(1)}%</span></span>
    </div>`;
  };

  const section = (title, icon, cards, emptyMsg) => `
    <div class="hm-an-section">
      <div class="hm-an-title">${icon} ${title}</div>
      ${cards.length ? `<div class="hm-an-scroll">${cards}</div>` : `<p class="muted" style="padding:8px">${emptyMsg}</p>`}
    </div>`;

  els.hmProgAnalytics.innerHTML = `
    <div class="hm-an-wrap">
      ${section('High Turnout Booths', '🔥', highTurnout.map(r => boothCard(r, turnoutMetric(r), 'hm-an-card--high')).join(''), 'No data yet — click Refresh')}
      ${section('Low Turnout Booths', '⚠️', lowTurnout.map(r => boothCard(r, turnoutMetric(r), 'hm-an-card--low')).join(''), 'No data yet — click Refresh')}
      ${section('High Minority Booths', '🕌', highMinority.map(r => boothCard(r, minorityMetric(r), 'hm-an-card--min')).join(''), 'No booth data')}
    </div>`;
}

function renderHmBoothDetailTable(mandalName) {
  if (!els.hmProgMandals) return;
  const { mandalMap } = getHmProgressData();
  const md = mandalMap[mandalName];
  if (!md) { els.hmProgMandals.innerHTML = ''; return; }

  // Compute status colour to match the mandal card header
  let dtWon = 0, dtLost = 0;
  md.booths.forEach(b => {
    const r = String(state.allBoothMap.get(Number(b.boothNo))?.boothRating || '').toUpperCase();
    if (['A','B','C'].includes(r)) dtWon++;
    else if (['D','E','F'].includes(r)) dtLost++;
  });
  const dtStatus = hmMandalStatus(dtWon, dtLost, md.A, md.B, md.E);

  const booths = md.booths.slice().sort((a, b) => a.boothNo - b.boothNo);
  const rows = booths.map(bth => {
    const cfg      = state.allBoothMap.get(Number(bth.boothNo)) || {};
    const bPct     = bth.total ? (bth.voted / bth.total) * 100 : 0;
    const bCls     = hmTurnoutClass(bPct);
    const insights = hmBoothEntryInsights(bth.boothNo, bth.total);
    const marginCell = cfg.marginVsInc !== undefined && cfg.marginVsInc !== null
      ? `<span class="${cfg.marginVsInc >= 0 ? 'hm-bc-margin--won' : 'hm-bc-margin--lost'}">${cfg.marginVsInc >= 0 ? '+' : ''}${(cfg.marginVsInc * 100).toFixed(1)}%</span>`
      : '—';
    const projBJP = calcProjectedBJP(bth.A, bth.B, bth.C, bth.D, bth.E);
    return `<tr>
      <td>${bth.boothNo}</td>
      <td class="hm-dt-name">${bth.name}</td>
      <td>${bth.total.toLocaleString('en-IN')}</td>
      <td>${bth.voted.toLocaleString('en-IN')}</td>
      <td class="${bCls}">${bPct.toFixed(1)}%</td>
      <td>${bth.nda ? bth.nda.toLocaleString('en-IN') : '—'}</td>
      <td class="hm-bjp-proj-val">${projBJP > 0 ? projBJP : '—'}</td>
      <td>${hmMarginGradeBadge(cfg)}</td>
      <td>${marginCell}</td>
      <td>${insights.tagged > 0 ? insights.taggedPct.toFixed(0) + '%' : '—'}</td>
      <td>${insights.tagged > 0 ? insights.ndaStrength.toFixed(0) + '%' : '—'}</td>
    </tr>`;
  });

  els.hmProgMandals.innerHTML = `
    <div class="hm-dt-wrap">
      <div class="hm-dt-header" style="background:${dtStatus.bg};color:${dtStatus.text}">
        <span class="hm-dt-title">${mandalName} — Booth Details <span style="opacity:0.8;font-size:11px;font-weight:500">(${dtStatus.label})</span></span>
        <button class="hm-dt-close" type="button">✕ Close</button>
      </div>
      <div class="hm-dt-scroll">
        <table class="hm-dt-table">
          <thead>
            <tr>
              <th>#</th><th>Booth Name</th><th>Total</th><th>Voted</th>
              <th>Turnout</th><th>NDA</th><th>Proj. BJP</th><th>Grade</th><th>2021 Margin</th>
              <th>Tagged%</th><th>NDA Str%</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    </div>`;
  els.hmProgMandals.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderHmOppositionView() {
  const { overall, mandalMap } = getHmProgressData();
  const totalBooths   = (state.allBooths || []).length;
  const overallPct    = overall.total ? (overall.voted / overall.total) * 100 : 0;
  const oppPct        = overall.tagged ? (overall.E / overall.tagged) * 100 : 0;
  const swingTotal    = overall.D;
  const strongholds   = Object.values(mandalMap).flatMap(m => m.booths).filter(b => b.E > b.nda && b.E > 0).length;
  const swingBooths   = Object.values(mandalMap).flatMap(m => m.booths).filter(b => b.D > b.nda && b.D > 0).length;
  const ringColor     = oppPct >= 40 ? '#c62828' : oppPct >= 20 ? '#f57c00' : '#2e7d32';
  const turnoutColor  = overallPct >= 60 ? '#2e7d32' : overallPct >= 30 ? '#f57c00' : '#c62828';

  els.hmProgOverall.innerHTML = `
    <div class="hm-prog-hero hm-prog-hero--opp">
      <div class="hm-prog-hero-top-row">
        <div class="hm-prog-hero-left">
          <div class="hm-prog-hero-label hm-opp-label">Opposition Analysis · AC 108</div>
          <div class="hm-prog-hero-row">
            <span class="hm-prog-hero-voted">${overall.voted.toLocaleString('en-IN')}</span>
            <span class="hm-prog-hero-sep"> / </span>
            <span class="hm-prog-hero-total">${overall.total.toLocaleString('en-IN')}</span>
            <span class="hm-prog-hero-pct ${hmTurnoutClass(overallPct)}">${overallPct.toFixed(1)}%</span>
          </div>
          <div class="hm-prog-hero-sublabel">Total turnout · Opposition (E): ${overall.E.toLocaleString('en-IN')} of ${overall.tagged.toLocaleString('en-IN')} tagged (${oppPct.toFixed(1)}%)</div>
        </div>
        <div class="hm-prog-hero-ring">${hmRing(oppPct, ringColor, 72)}</div>
      </div>
      ${hmProgressBar(overallPct, 'hm-prog-bar--hero')}
      <div class="hm-prog-stat-tiles">
        <div class="hm-prog-tile hm-tile-opp">
          <div class="hm-prog-tile-val hm-opp-val">${overall.E.toLocaleString('en-IN')}</div>
          <div class="hm-prog-tile-label">Opposition (E)</div>
        </div>
        <div class="hm-prog-tile hm-tile-swing">
          <div class="hm-prog-tile-val hm-swing-val">${swingTotal.toLocaleString('en-IN')}</div>
          <div class="hm-prog-tile-label">Swing (D)</div>
        </div>
        <div class="hm-prog-tile">
          <div class="hm-prog-tile-val ${strongholds > 0 ? 'hm-opp-val' : 'hm-tile-ok'}">${strongholds}</div>
          <div class="hm-prog-tile-label">Opp Strongholds</div>
        </div>
        <div class="hm-prog-tile">
          <div class="hm-prog-tile-val ${swingBooths > 0 ? 'hm-swing-val' : 'hm-tile-ok'}">${swingBooths}</div>
          <div class="hm-prog-tile-label">Swing-Risk Booths</div>
        </div>
      </div>
      <div class="hm-prog-seg-wrap">
        <div class="hm-prog-seg-label">Voter Composition across AC 108</div>
        ${hmSegBar(overall.A, overall.B, overall.C, overall.D, overall.E, overall.total)}
        <div class="hm-seg-legend">
          <span class="hm-seg-dot hm-seg-a"></span>A BJP ${overall.A}
          <span class="hm-seg-dot hm-seg-b"></span>B NDA ${overall.B}
          <span class="hm-seg-dot hm-seg-c"></span>C Supp ${overall.C}
          <span class="hm-seg-dot hm-seg-d"></span>D Swing ${overall.D}
          <span class="hm-seg-dot hm-seg-e"></span>E Opp ${overall.E}
        </div>
      </div>
      <div class="hm-prog-nda-strip hm-opp-vs-nda">
        NDA ${overall.nda.toLocaleString('en-IN')} vs Opposition ${overall.E.toLocaleString('en-IN')}
        — ${overall.nda >= overall.E
          ? `NDA leads by <strong>${(overall.nda - overall.E).toLocaleString('en-IN')}</strong>`
          : `Opposition leads by <strong>${(overall.E - overall.nda).toLocaleString('en-IN')}</strong>`}
        — Swing voters: <strong>${overall.D.toLocaleString('en-IN')}</strong>
      </div>
    </div>`;

  // ── Opposition hotspots ──────────────────────────────────────────────────────
  if (els.hmProgAlerts) {
    const hotspots = Object.values(mandalMap).flatMap(m => m.booths)
      .filter(b => b.tagged > 0)
      .map(b => ({ ...b, oppPct: (b.E / b.tagged) * 100, threat: b.E - b.nda }))
      .filter(b => b.E > 0)
      .sort((a, b) => b.threat - a.threat)
      .slice(0, 6);

    if (hotspots.length) {
      els.hmProgAlerts.innerHTML = `
        <div class="hm-alerts-block hm-alerts-block--opp">
          <div class="hm-alerts-title hm-opp-alert-title">Opposition Hotspots — top ${hotspots.length} booths by threat</div>
          <div class="hm-alerts-list">
            ${hotspots.map(b => {
              const oppBar = `<div class="hm-opp-vs-bar">
                <div class="hm-opp-vs-nda" style="width:${b.nda && b.tagged ? ((b.nda/b.tagged)*100).toFixed(1) : 0}%" title="NDA"></div>
                <div class="hm-opp-vs-e"   style="width:${b.tagged ? ((b.E/b.tagged)*100).toFixed(1) : 0}%" title="Opp"></div>
              </div>`;
              return `<div class="hm-alert-row">
                <span class="hm-alert-booth">#${b.boothNo}</span>
                <span class="hm-alert-name">${b.name}</span>
                <div class="hm-alert-right">
                  ${oppBar}
                  <span class="hm-alert-pct hm-opp-val">E ${b.E}</span>
                  <span class="hm-alert-nda hm-nda-badge">NDA ${b.nda}</span>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    } else {
      els.hmProgAlerts.innerHTML = '';
    }
  }

  // ── Mandal tabs (Opposition view — same sort/logic as NDA) ──────────────────
  const mandalRows = Object.entries(mandalMap).sort((a, b) => {
    const aPct = a[1].total ? a[1].voted / a[1].total : 0;
    const bPct = b[1].total ? b[1].voted / b[1].total : 0;
    return aPct - bPct; // worst turnout first — same as NDA view
  });

  hmRenderMandalTabs(
    mandalRows,
    (mandal, md) => {
      const mPct    = md.total ? (md.voted / md.total) * 100 : 0;
      const mNdaWin = md.nda >= md.E;
      return {
        metric:    mPct.toFixed(1) + '%',
        subtext:   md.booths.length + ' booths',
        panelBar:  hmProgressBar(mPct, 'hm-prog-bar--mandal'),
        panelStats:`<span>${md.voted.toLocaleString('en-IN')} voted / ${md.total.toLocaleString('en-IN')}</span>
                    <span class="hm-opp-val">E ${md.E} opp</span>
                    <span class="hm-swing-val">D ${md.D} swing</span>
                    <span class="hm-panel-stat-nda ${mNdaWin ? 'hm-panel-stat-nda--ok' : 'hm-panel-stat-nda--behind'}">NDA ${md.nda.toLocaleString('en-IN')}</span>`,
        ndaBadge:  `<span class="${mNdaWin ? 'hm-bc-nda hm-bc-nda--ok' : 'hm-bc-threat'}">
                      ${mNdaWin ? 'NDA leads' : 'Opp leads +' + (md.E - md.nda)}</span>`,
      };
    },
    (md) => md.booths.sort((a, b) => a.boothNo - b.boothNo).map(bth => {
      const bPct    = bth.total ? (bth.voted / bth.total) * 100 : 0;
      const bCls    = hmTurnoutClass(bPct);
      const threat  = bth.E - bth.nda;
      const ndaTag  = bth.nda ? `<span class="hm-bc-nda ${bth.nda >= bth.E ? 'hm-bc-nda--ok' : ''}">NDA ${bth.nda}</span>` : '';
      const swingTag= bth.D   ? `<span class="hm-bc-swing">D ${bth.D}</span>` : '';
      const eTag    = bth.E   ? `<span class="hm-bc-e-badge ${threat > 0 ? 'hm-bc-e-badge--threat' : ''}">E ${bth.E}</span>` : '';
      return `<div class="hm-bc hm-bc--${bCls.replace('hm-turn-','')}">
        <div class="hm-bc-top">
          <span class="hm-bc-no">${bth.boothNo}</span>
          ${hmBoothRatingBadge(bth.boothNo)}
          <span class="hm-bc-pct ${bCls}">${bPct.toFixed(1)}%</span>
        </div>
        <div class="hm-bc-name">${bth.name}</div>
        ${hmProgressBar(bPct, 'hm-prog-bar--booth')}
        <div class="hm-bc-bottom">
          <span class="hm-bc-nums">${bth.voted}/${bth.total}</span>
          ${ndaTag}${eTag}
        </div>
        ${bth.D || bth.E ? `<div class="hm-bc-opp-row">${swingTag}${threat > 0 ? `<span class="hm-bc-threat">+${threat} risk</span>` : ''}</div>` : ''}
      </div>`;
    }).join('')
  );
}

async function onHmProgRefresh() {
  if (state.hmProgLoading) return;
  state.hmProgLoading = true;
  if (els.hmProgRefreshBtn) { els.hmProgRefreshBtn.disabled = true; els.hmProgRefreshBtn.textContent = 'Loading…'; }

  const allBooths = state.allBooths || [];
  const total = allBooths.length;
  let done = 0;

  const processOneBooth = async (b) => {
    const boothNo = Number(b.booth);
    try {
      const saved = await loadSavedAffinity(boothNo);
      const totalVoters = Number(b.totalVoters) || 0;

      // Voted counts
      const votedRows = saved.filter(r => readTruthyFlag(r.voted ?? r.Voted));
      const votedCount = votedRows.length;
      state.hmVotedBooths[boothNo] = votedCount;
      state.hmVotedSlNos[boothNo]  = votedRows.map(r => Number(r.slNo ?? r.SlNo ?? 0)).filter(Boolean);
      const votedSlSet = new Set(state.hmVotedSlNos[boothNo]);

      // Always rebuild the cache entry from fresh server data so summary + voters are consistent.
      // Drafts are re-applied on-demand in fetchBoothData when the Entry tab opens the booth.
      const entry = state.pageCache[boothNo] || createBoothData(totalVoters);
      applySavedAffinity(saved, entry, totalVoters);
      state.pageCache[boothNo] = entry;

      // Compute votedSummary (ABCDE of voters who have BOTH a tag AND voted)
      const votedSummary = { A:0, B:0, C:0, D:0, E:0 };
      saved.forEach(r => {
        const a = String(r.affinity || '').toUpperCase();
        const sl = Number(r.slNo ?? r.SlNo ?? 0);
        if (a && Object.prototype.hasOwnProperty.call(votedSummary, a) && votedSlSet.has(sl)) {
          votedSummary[a]++;
        }
      });
      state.pageCache[boothNo].votedSummary = votedSummary;
      state.pageCache[boothNo].votedCount   = votedCount;
    } catch (err) {
      console.warn(`[Refresh] Booth ${boothNo} failed:`, err.message || err);
    }
    done++;
    if (els.hmProgRefreshBtn) els.hmProgRefreshBtn.textContent = `Loading… ${done}/${total}`;
    if (done % 20 === 0) renderHmProgressView();
  };

  // Concurrency pool — 8 parallel requests instead of sequential
  let idx = 0;
  const worker = async () => {
    while (idx < allBooths.length) {
      await processOneBooth(allBooths[idx++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(20, total) }, worker));

  renderHmProgressView();
  state.hmProgLoading = false;
  if (els.hmProgRefreshBtn) { els.hmProgRefreshBtn.disabled = false; els.hmProgRefreshBtn.textContent = 'Refresh'; }
}

// ── Voter Heatmap ─────────────────────────────────────────────────────────────
function initHeatmapIfNeeded() {
  if (!canViewVotedFlag()) return;
  if (!state.hmFiltersPopulated) {
    populateHmMandalFilter();
    state.hmFiltersPopulated = true;
  }
  if (!state.hmBoothNo) {
    showHmPrompt();
  }
}

function populateHmMandalFilter() {
  if (!els.hmMandalBtns) return;
  const all = state.allBooths || [];
  const mandals = [...new Set(all.map(b => String(b.mandal || '').trim()).filter(Boolean))].sort();
  els.hmMandalBtns.innerHTML = mandals.map(m => {
    const count = all.filter(b => String(b.mandal || '').trim() === m).length;
    return `<button type="button" class="hm-mandal-btn" data-mandal="${m}">${m}<span class="hm-mandal-count">${count}</span></button>`;
  }).join('');
}

function renderHmVotedReport() {
  if (!els.hmVotedReport || !els.hmVotedFilterChk) return;
  if (!els.hmVotedFilterChk.checked) {
    els.hmVotedReport.style.display = 'none';
    return;
  }

  const allBooths = state.allBooths || [];
  const withVotes = allBooths
    .filter(b => (state.hmVotedBooths[Number(b.booth)] || 0) > 0)
    .map(b => {
      const bn   = Number(b.booth);
      const slNos = (state.hmVotedSlNos[bn] || []).slice().sort((a, x) => a - x);
      return { bn, name: b.village || '', mandal: String(b.mandal || '').trim(), count: state.hmVotedBooths[bn], slNos };
    })
    .sort((a, b) => a.bn - b.bn);

  if (!withVotes.length) {
    els.hmVotedReport.innerHTML = '<div class="hm-vr-empty">No votes recorded yet. Click Refresh to load latest data.</div>';
    els.hmVotedReport.style.display = 'block';
    return;
  }

  // Group by mandal preserving sort order
  const mandalOrder = [], mandalGroups = {};
  withVotes.forEach(b => {
    if (!mandalGroups[b.mandal]) { mandalGroups[b.mandal] = []; mandalOrder.push(b.mandal); }
    mandalGroups[b.mandal].push(b);
  });

  const totalVoted = withVotes.reduce((s, b) => s + b.count, 0);

  els.hmVotedReport.innerHTML = `
    <div class="hm-vr-wrap">
      <div class="hm-vr-summary">
        <strong>${totalVoted}</strong> votes cast across <strong>${withVotes.length}</strong> booths
      </div>
      ${mandalOrder.map(mandal => `
        <div class="hm-vr-mandal">
          <div class="hm-vr-mandal-hdr">${mandal}</div>
          ${mandalGroups[mandal].map(b => `
            <div class="hm-vr-booth">
              <div class="hm-vr-booth-hdr">
                <span class="hm-vr-booth-no">#${b.bn}</span>
                <span class="hm-vr-booth-name">${b.name}</span>
                <span class="hm-vr-booth-count">${b.count} voted</span>
              </div>
              ${b.slNos.length ? `<div class="hm-vr-sl-grid">${b.slNos.map(sl => `<span class="hm-vr-sl">${sl}</span>`).join('')}</div>` : ''}
            </div>`).join('')}
        </div>`).join('')}
    </div>`;
  els.hmVotedReport.style.display = 'block';
}

function renderHmBoothButtons(mandal) {
  if (!els.hmBoothBtns) return;
  const all = state.allBooths || [];
  const src = mandal ? all.filter(b => String(b.mandal || '').trim() === mandal) : [];
  const sorted = src.slice().sort((a, b) => Number(a.booth) - Number(b.booth));
  if (!sorted.length) { els.hmBoothBtns.style.display = 'none'; return; }
  els.hmBoothBtns.innerHTML = sorted.map(b => {
    const cfg    = state.allBoothMap?.get(Number(b.booth)) || {};
    const rating = String(cfg.boothRating || '').toUpperCase();
    const ratingClass = rating ? `hm-booth-btn--grade-${rating.toLowerCase()}` : '';
    const cache  = state.pageCache[Number(b.booth)];
    const summary = cache?.summary || {};
    const A=Number(summary.A||0), B=Number(summary.B||0);
    const total  = Number(b.voters || b.totalVoters || 0);
    const ndaPct = total > 0 ? Math.round(((A+B)/total)*100) : 0;
    return `<button type="button" class="hm-booth-btn ${ratingClass}" data-booth="${b.booth}"
              title="${cfg.boothGrade || ''}">
       <span class="hm-bb-no">${b.booth}</span>
       <span class="hm-bb-name">${b.village || ''}</span>
       ${rating ? `<span class="hm-bb-rating">${rating}</span>` : ''}
       ${ndaPct > 0 ? `<span class="hm-bb-nda">${ndaPct}%</span>` : ''}
     </button>`;
  }).join('');
  els.hmBoothBtns.style.display = 'flex';
}

function showHmPrompt(msg) {
  if (els.hmLoading)    els.hmLoading.style.display = 'none';
  if (els.hmGrid)       els.hmGrid.style.display    = 'none';
  if (els.hmPrompt)  {  els.hmPrompt.textContent = msg || 'Select a Mandal above to begin.'; els.hmPrompt.style.display = 'block'; }
  if (els.hmStats)      els.hmStats.innerHTML       = '';
  if (els.hmSaveStatus) els.hmSaveStatus.textContent = '';
  if (els.hmLegend)     els.hmLegend.style.display  = 'none';
}

// Write hmVoters back into pageCache so Progress view always reads correct data.
// Preserves existing summary (ABCDE) from cache; recomputes it from hmVoters if absent.
function syncHmVotersToCache(boothNo) {
  if (!boothNo || !state.hmVoters.length) return;
  const existing = state.pageCache[boothNo];

  // Compute ABCDE summary from hmVoters affinity data
  const summary = { A:0, B:0, C:0, D:0, E:0 };
  state.hmVoters.forEach(v => {
    const a = String(v.affinity || '').toUpperCase();
    if (a && Object.prototype.hasOwnProperty.call(summary, a)) summary[a]++;
  });
  const entry = existing ? existing : createBoothData(state.hmVoters.length);
  const votedCount = state.hmVoters.filter(v => v.voted && !v.deleted).length;
  entry.votedCount = votedCount;
  entry.summary = summary; // always use fresh server data from hmVoters

  // Voted-by-affinity: only voters who have BOTH a tag AND voted
  const votedSummary = { A:0, B:0, C:0, D:0, E:0 };
  state.hmVoters.forEach(v => {
    if (!v.voted || v.deleted) return;
    const a = String(v.affinity || '').toUpperCase();
    if (a && Object.prototype.hasOwnProperty.call(votedSummary, a)) votedSummary[a]++;
  });
  entry.votedSummary = votedSummary;

  // Sync voted flags into voters array
  if (entry.voters?.length) {
    const hmMap = new Map(state.hmVoters.map(v => [v.slNo, v]));
    entry.voters.forEach(cv => {
      const hv = hmMap.get(cv.slNo);
      if (hv) cv.voted = hv.voted;
    });
  }

  state.pageCache[boothNo] = entry;

  // Track voted count + SL numbers in dedicated maps — used by Progress view and voted report
  state.hmVotedBooths[boothNo] = votedCount;
  state.hmVotedSlNos[boothNo]  = state.hmVoters.filter(v => v.voted && !v.deleted).map(v => v.slNo);
  renderHmVotedReport(); // keep report in sync if checkbox is active

  // If Entry tab is currently showing this booth, sync voted flags into live boothData
  if (boothNo === getCurrentBoothNumber() && state.boothData?.voters?.length) {
    const hmMap = new Map(state.hmVoters.map(v => [v.slNo, v]));
    state.boothData.voters.forEach(cv => {
      const hv = hmMap.get(cv.slNo);
      if (hv) cv.voted = hv.voted;
    });
    updateBoothFlagCounts(state.boothData);
    renderVoters();
  }
}

async function loadHeatmapBooth(boothNo) {
  if (!canViewVotedFlag()) return;
  if (!boothNo) { showHmPrompt(); return; }

  boothNo = Number(boothNo);

  // Already loaded — re-render immediately
  if (state.hmBoothNo === boothNo && state.hmVoters.length) {
    renderHeatmapGrid();
    return;
  }

  if (els.hmPrompt)     els.hmPrompt.style.display     = 'none';
  if (els.hmGrid)       els.hmGrid.style.display       = 'none';
  if (els.hmLoading) {  els.hmLoading.style.display    = 'block'; els.hmLoading.textContent = `Loading Booth ${boothNo}…`; }
  if (els.hmStats)      els.hmStats.innerHTML          = '';
  if (els.hmSaveStatus) els.hmSaveStatus.textContent   = '';

  try {
    // Load voter serial numbers from local file (fast, no API needed)
    const res = await fetch(`voter_data/${boothNo}.json`);
    if (!res.ok) throw new Error(`Could not load voter data (HTTP ${res.status})`);
    const raw = await res.json();

    // Build voter list — include deleted entries but flag them
    const voters = (raw.rows || [])
      .map(r => ({ slNo: r[0], affinity: '', relocated: false, voted: false, deleted: String(r[7] || '').toUpperCase() === 'Y' }));

    // Overlay voted flags from page cache if already loaded
    const cached = state.pageCache[boothNo];
    if (cached?.voters?.length) {
      const cachedMap = new Map(cached.voters.map(v => [v.slNo, v]));
      voters.forEach(v => {
        const cv = cachedMap.get(v.slNo);
        if (cv) { v.affinity = cv.affinity || ''; v.relocated = !!cv.relocated; v.voted = !!cv.voted; }
      });
    } else {
      // Try fetching saved affinity in background to get voted flags
      try {
        const savedRows = await loadSavedAffinity(boothNo);
        const savedMap  = new Map(savedRows.map(r => [Number(r.slNo ?? r['Sl#']), r]));
        voters.forEach(v => {
          const s = savedMap.get(v.slNo);
          if (s) { v.affinity = s.affinity || ''; v.relocated = readTruthyFlag(s.relocated); v.voted = readTruthyFlag(s.voted ?? s.Voted); }
        });
      } catch (_) { /* show without voted flags if API unavailable */ }
    }

    state.hmBoothNo = boothNo;
    state.hmVoters  = voters;

    // Always write a cache entry so the Progress view reads correct data
    syncHmVotersToCache(boothNo);

    renderHeatmapGrid();
  } catch (err) {
    if (els.hmLoading) els.hmLoading.style.display = 'none';
    if (els.hmPrompt) {
      els.hmPrompt.textContent = 'Error: ' + (err.message || err);
      els.hmPrompt.style.display = 'block';
    }
  }
}

function renderHeatmapGrid() {
  if (els.hmLoading) els.hmLoading.style.display = 'none';
  if (!els.hmGrid) return;
  if (!state.hmVoters.length) {
    if (els.hmPrompt) { els.hmPrompt.textContent = 'No voter data found for this booth.'; els.hmPrompt.style.display = 'block'; }
    return;
  }

  const voters     = state.hmVoters;
  const active     = voters.filter(v => !v.deleted);
  const total      = active.length;
  const votedCount = active.filter(v => v.voted).length;
  const pct        = total ? Math.round((votedCount / total) * 100) : 0;

  if (els.hmStats) {
    els.hmStats.innerHTML =
      `<span class="hm-stat-voted">${votedCount}</span> / <span class="hm-stat-total">${total}</span> voted &nbsp; <span class="hm-stat-pct">${pct}%</span>`;
  }

  els.hmGrid.innerHTML = voters.map(v => {
    if (v.deleted) {
      return `<div class="hm-cell hm-cell--deleted" title="Sl# ${v.slNo} (Deleted)">${v.slNo}</div>`;
    }
    const af = String(v.affinity || '').toUpperCase();
    const afClass = af && 'ABCDE'.includes(af) ? ` hm-cell--af-${af.toLowerCase()}` : '';
    const votedClass = v.voted ? ' hm-cell--voted' : ' hm-cell--not-voted';
    const label = af && 'ABCDE'.includes(af) ? af : '';
    return `<div class="hm-cell${afClass}${votedClass}" data-sl="${v.slNo}" title="Sl# ${v.slNo}${af ? ' · ' + af : ''}">${v.slNo}${label ? `<span class="hm-cell-af">${label}</span>` : ''}</div>`;
  }).join('');

  els.hmGrid.style.display = 'grid';
  if (els.hmPrompt) els.hmPrompt.style.display = 'none';

  if (els.hmLegend) {
    els.hmLegend.innerHTML = `
      <div class="hm-legend-title">Colour Guide</div>
      <div class="hm-legend-groups">
        <div class="hm-legend-group">
          <div class="hm-legend-group-label">Voted ✓</div>
          <div class="hm-legend-items">
            <span class="hm-legend-cell hm-cell--af-a hm-cell--voted">A</span>
            <span class="hm-legend-cell hm-cell--af-b hm-cell--voted">B</span>
            <span class="hm-legend-cell hm-cell--af-c hm-cell--voted">C</span>
            <span class="hm-legend-cell hm-cell--af-d hm-cell--voted">D</span>
            <span class="hm-legend-cell hm-cell--af-e hm-cell--voted">E</span>
            <span class="hm-legend-cell hm-cell--voted hm-legend-cell--untagged">?</span>
          </div>
        </div>
        <div class="hm-legend-group">
          <div class="hm-legend-group-label">Not Yet Voted</div>
          <div class="hm-legend-items">
            <span class="hm-legend-cell hm-cell--af-a hm-cell--not-voted">A</span>
            <span class="hm-legend-cell hm-cell--af-b hm-cell--not-voted">B</span>
            <span class="hm-legend-cell hm-cell--af-c hm-cell--not-voted">C</span>
            <span class="hm-legend-cell hm-cell--af-d hm-cell--not-voted">D</span>
            <span class="hm-legend-cell hm-cell--af-e hm-cell--not-voted">E</span>
            <span class="hm-legend-cell hm-cell--not-voted hm-legend-cell--untagged">?</span>
          </div>
        </div>
      </div>
      <div class="hm-legend-labels">
        <span><span class="hm-legend-dot" style="background:#1565c0"></span>A — BJP confirmed</span>
        <span><span class="hm-legend-dot" style="background:#2e7d32"></span>B — NDA supporter</span>
        <span><span class="hm-legend-dot" style="background:#e65100"></span>C — BJP sympathiser</span>
        <span><span class="hm-legend-dot" style="background:#6a1b9a"></span>D — Undecided</span>
        <span><span class="hm-legend-dot" style="background:#c62828"></span>E — Opposition</span>
        <span><span class="hm-legend-dot" style="background:#aaa"></span>? — Not tagged</span>
      </div>`;
    els.hmLegend.style.display = 'block';
  }
}

async function onHeatmapCellClick(cell) {
  if (!canEditVotedFlag() || state.hmSaving) return;
  if (cell.classList.contains('hm-cell--deleted')) return;
  const slNo = Number(cell.dataset.sl);
  const voter = state.hmVoters.find(v => v.slNo === slNo);
  if (!voter || voter.deleted) return;

  // Optimistic toggle
  voter.voted = !voter.voted;
  cell.classList.toggle('hm-cell--voted',     voter.voted);
  cell.classList.toggle('hm-cell--not-voted', !voter.voted);

  // Update stats immediately
  const votedCount = state.hmVoters.filter(v => v.voted && !v.deleted).length;
  const total      = state.hmVoters.length;
  const pct        = total ? Math.round((votedCount / total) * 100) : 0;
  if (els.hmStats) {
    els.hmStats.innerHTML =
      `<span class="hm-stat-voted">${votedCount}</span> / <span class="hm-stat-total">${total}</span> voted &nbsp; <span class="hm-stat-pct">${pct}%</span>`;
  }

  // Save to Google Sheets
  state.hmSaving = true;
  if (els.hmSaveStatus) els.hmSaveStatus.textContent = 'Saving…';

  try {
    const boothData = {
      voters: state.hmVoters.map(v => ({
        slNo:      v.slNo,
        affinity:  v.affinity,
        relocated: v.relocated,
        voted:     v.voted,
      }))
    };
    const payload = {
      action: 'saveBoothAffinities',
      booth:  state.hmBoothNo,
      voters: boothData.voters,
    };
    const result = await postApi(payload);
    if (result && result.ok === false) throw new Error(result.message || 'Save failed');

    // Always sync cache (creates entry if absent) so Progress view stays accurate
    syncHmVotersToCache(state.hmBoothNo);
    if (els.hmSaveStatus) {
      els.hmSaveStatus.textContent = `Saved — Sl# ${slNo} marked ${voter.voted ? 'voted' : 'unvoted'}`;
      setTimeout(() => { if (els.hmSaveStatus) els.hmSaveStatus.textContent = ''; }, 3000);
    }
  } catch (err) {
    // Revert on error
    voter.voted = !voter.voted;
    cell.classList.toggle('hm-cell--voted',     voter.voted);
    cell.classList.toggle('hm-cell--not-voted', !voter.voted);
    const errMsg = 'Save failed: ' + (err.message || err);
    console.error('[Heatmap]', errMsg);
    if (els.hmSaveStatus) {
      els.hmSaveStatus.textContent = errMsg;
      els.hmSaveStatus.style.color = 'var(--red, #c00)';
      setTimeout(() => { if (els.hmSaveStatus) { els.hmSaveStatus.textContent = ''; els.hmSaveStatus.style.color = ''; } }, 6000);
    }
  } finally {
    state.hmSaving = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    alert(err.message || 'App failed to load');
  });
});

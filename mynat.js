// MyNat — app logic. Runs after the inline auth module in index.html defines
// window._supabase and calls window._bootApp(user) on sign-in.

// iNat's 13 official iconic taxa (verified against a live 1678-observation
// account — Animalia genuinely shows up, it's their "Other Animals" catch-all
// for things like worms/corals not covered by the more specific buckets)
// plus an Unknown fallback for the rare null case.
const ICONIC_TAXA = {
  Aves: { label: 'Birds', color: 'var(--tax-aves)' },
  Mammalia: { label: 'Mammals', color: 'var(--tax-mammalia)' },
  Reptilia: { label: 'Reptiles', color: 'var(--tax-reptilia)' },
  Amphibia: { label: 'Amphibians', color: 'var(--tax-amphibia)' },
  Actinopterygii: { label: 'Ray-finned Fishes', color: 'var(--tax-actinopterygii)' },
  Mollusca: { label: 'Mollusks', color: 'var(--tax-mollusca)' },
  Arachnida: { label: 'Arachnids', color: 'var(--tax-arachnida)' },
  Insecta: { label: 'Insects', color: 'var(--tax-insecta)' },
  Plantae: { label: 'Plants', color: 'var(--tax-plantae)' },
  Fungi: { label: 'Fungi', color: 'var(--tax-fungi)' },
  Chromista: { label: 'Chromista', color: 'var(--tax-chromista)' },
  Protozoa: { label: 'Protozoans', color: 'var(--tax-protozoa)' },
  Animalia: { label: 'Other Animals', color: 'var(--tax-animalia)' },
  Unknown: { label: 'Unknown', color: 'var(--tax-unknown)' },
};

function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

async function apiFetch(action, opts = {}) {
  const { data: { session } } = await window._supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(`/api?action=${encodeURIComponent(action)}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  return res.json();
}

function initTabs() {
  const buttons = document.querySelectorAll('.tabbtn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      buttons.forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tabpanel').forEach(p => {
        p.classList.toggle('active', p.id === `tab-${tab}`);
      });
      // Search/filter bar is shared by Map + List, hidden on Overview.
      document.getElementById('filterbar').style.display = tab === 'overview' ? 'none' : 'flex';
      if (tab === 'list') loadObservations(true);
      if (tab === 'map') {
        initMap();
        setTimeout(() => _map.invalidateSize(), 0);
        loadMapPoints();
      }
    });
  });
}

function initUserMenu(user) {
  const userBtn = document.getElementById('user-btn');
  const card = document.getElementById('config-card');
  document.getElementById('cfg-email').textContent = user.email || '';

  userBtn.addEventListener('click', () => {
    const open = card.classList.toggle('open');
    if (open) {
      const r = userBtn.getBoundingClientRect();
      card.style.top = `${r.bottom + 8}px`;
    }
  });

  document.addEventListener('click', e => {
    if (!card.contains(e.target) && e.target !== userBtn) card.classList.remove('open');
  });
}

// Shared by Detail List (this phase) and eventually Map (Phase 5) — filter
// state lives here so a future Map tab can reuse the same search/category
// inputs without duplicating the wiring.
let _listSearch = '';
let _listCategories = [];

function isListActive() {
  return document.getElementById('tab-list').classList.contains('active');
}

function onFiltersChanged() {
  if (isListActive()) loadObservations(true);
  if (isMapActive()) loadMapPoints();
}

function initFilterBar() {
  const searchInput = document.getElementById('search-input');
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      _listSearch = searchInput.value.trim();
      onFiltersChanged();
    }, 300);
  });

  document.querySelectorAll('.chip[data-category]').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      _listCategories = [...document.querySelectorAll('.chip[data-category].active')]
        .map(c => c.dataset.category);
      onFiltersChanged();
    });
  });
}

function setSyncStatus(text) {
  const el = document.getElementById('connected-sync-status');
  if (el) el.textContent = text;
}

function renderOverview(profile) {
  const emptyEl = document.getElementById('overview-empty');
  const connectedEl = document.getElementById('overview-connected');
  if (profile) {
    emptyEl.style.display = 'none';
    connectedEl.style.display = '';
    document.getElementById('connected-username').textContent = `@${profile.inat_username}`;
    setSyncStatus(profile.last_synced_at
      ? `Last synced ${new Date(profile.last_synced_at).toLocaleString()}`
      : 'Not synced yet.');
  } else {
    emptyEl.style.display = '';
    connectedEl.style.display = 'none';
    document.getElementById('connect-form').style.display = 'none';
    document.getElementById('connect-inat-btn').style.display = '';
  }
}

// 'count' (observations per category) or 'speciesCount' (distinct species per
// category) — toggled by clicking the Observations/Species stat cards.
let _statsMetric = 'count';
let _lastStats = null;

function renderCategoryBreakdown() {
  const stats = _lastStats;
  if (!stats) return;

  document.querySelectorAll('.stat-card[data-metric]').forEach(card => {
    card.classList.toggle('active', card.dataset.metric === _statsMetric);
  });

  const breakdown = document.getElementById('category-breakdown');
  breakdown.innerHTML = '';

  if (stats.total === 0) {
    breakdown.innerHTML = '<p class="cat-empty">No observations synced yet.</p>';
    return;
  }

  const metric = _statsMetric;
  const sorted = [...stats.categories].sort((a, b) => b[metric] - a[metric]);
  const maxVal = Math.max(...sorted.map(c => c[metric]));

  for (const cat of sorted) {
    const meta = ICONIC_TAXA[cat.iconic_taxon] || ICONIC_TAXA.Unknown;
    const value = cat[metric];
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <div class="cat-label">${meta.label}</div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${maxVal ? (value / maxVal * 100).toFixed(1) : 0}%; background:${meta.color}"></div></div>
      <div class="cat-count">${value.toLocaleString()}</div>
    `;
    breakdown.appendChild(row);
  }
}

function initStatsToggle() {
  document.querySelectorAll('.stat-card[data-metric]').forEach(card => {
    card.addEventListener('click', () => {
      _statsMetric = card.dataset.metric;
      renderCategoryBreakdown();
    });
  });
}

function renderStats(stats) {
  _lastStats = stats;
  document.getElementById('stat-total').textContent = stats.total.toLocaleString();
  document.getElementById('stat-species').textContent = stats.speciesCount.toLocaleString();
  document.getElementById('stat-daterange').textContent = stats.earliest && stats.latest
    ? `${formatDate(stats.earliest)} – ${formatDate(stats.latest)}`
    : '–';
  renderCategoryBreakdown();
}

async function loadStats() {
  const result = await apiFetch('stats');
  if (!result.ok) return;
  renderStats(result.stats);
}

async function loadProfile() {
  const result = await apiFetch('profile');
  if (!result.ok) return;
  renderOverview(result.profile);
  if (result.profile) loadStats();
}

// "Connect your iNat username" flow — resolves the username against iNat's
// public /v1/users/autocomplete via the server (api/index.js action=link-inat,
// which only accepts an exact login match) and upserts mynat_profiles.
function initConnectFlow() {
  const btn = document.getElementById('connect-inat-btn');
  const form = document.getElementById('connect-form');
  const input = document.getElementById('inat-username-input');
  const submitBtn = document.getElementById('connect-submit-btn');
  const errorEl = document.getElementById('connect-error');
  const changeBtn = document.getElementById('change-username-btn');
  if (!btn) return;

  function showForm() {
    btn.style.display = 'none';
    form.style.display = '';
    errorEl.textContent = '';
    input.focus();
  }

  btn.addEventListener('click', showForm);

  changeBtn.addEventListener('click', () => {
    document.getElementById('overview-connected').style.display = 'none';
    document.getElementById('overview-empty').style.display = '';
    showForm();
  });

  async function submitUsername() {
    const username = input.value.trim();
    if (!username) return;
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting…';
    const result = await apiFetch('link-inat', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    submitBtn.disabled = false;
    submitBtn.textContent = 'Connect';
    if (!result.ok) {
      errorEl.textContent = result.error || 'Could not connect. Try again.';
      return;
    }
    form.style.display = 'none';
    renderOverview(result.profile);
    runSync(); // "Connect" always kicks off the initial full import
  }

  submitBtn.addEventListener('click', submitUsername);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submitUsername(); });
}

// Pages through api?action=sync until the server reports hasMore:false. Each
// call only covers a few iNat pages (see api/index.js) to stay well under
// Vercel's function time limit, so a full historical import takes several
// round trips for an active account — this loop just keeps calling with the
// server-supplied nextPage until it's done.
let _syncing = false;

async function runSync() {
  if (_syncing) return;
  _syncing = true;
  const btn = document.getElementById('sync-now-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

  let page = 1;
  let total = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      const result = await apiFetch('sync', {
        method: 'POST',
        body: JSON.stringify({ page }),
      });
      if (!result.ok) {
        setSyncStatus(`Sync failed: ${result.error || 'unknown error'}`);
        return;
      }
      total += result.imported;
      hasMore = result.hasMore;
      page = result.nextPage;
      setSyncStatus(`Synced ${total} observation${total === 1 ? '' : 's'}…`);
    }
    setSyncStatus(`Synced ${total} observation${total === 1 ? '' : 's'} — up to date.`);
    await loadProfile();
  } finally {
    _syncing = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Sync now'; }
  }
}

function initSyncFlow() {
  const btn = document.getElementById('sync-now-btn');
  if (!btn) return;
  btn.addEventListener('click', () => runSync());
}

// Built via DOM APIs (not innerHTML) since common_name/scientific_name/
// place_guess come from other iNat users' free-text data, not just the
// signed-in user's own — textContent/attribute assignment keeps that safe
// without having to hand-escape every field.
function buildObsCard(obs) {
  const meta = ICONIC_TAXA[obs.iconic_taxon] || ICONIC_TAXA.Unknown;
  const name = obs.common_name || obs.scientific_name || 'Unknown';
  const metaParts = [obs.observed_on ? formatDate(obs.observed_on) : 'Undated'];
  if (obs.place_guess) metaParts.push(obs.place_guess);

  const card = document.createElement('a');
  card.className = 'obs-card';
  card.href = `https://www.inaturalist.org/observations/${obs.inat_id}`;
  card.target = '_blank';
  card.rel = 'noopener';

  const thumbUrl = obs.photos?.[0]?.square;
  if (thumbUrl) {
    const img = document.createElement('img');
    img.className = 'obs-thumb';
    img.src = thumbUrl;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'obs-thumb placeholder';
    placeholder.textContent = '🌿';
    card.appendChild(placeholder);
  }

  const info = document.createElement('div');
  info.className = 'obs-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'obs-name';
  nameEl.textContent = name;
  info.appendChild(nameEl);

  if (obs.scientific_name && obs.common_name) {
    const sciEl = document.createElement('div');
    sciEl.className = 'obs-sci';
    sciEl.textContent = obs.scientific_name;
    info.appendChild(sciEl);
  }

  const metaRow = document.createElement('div');
  metaRow.className = 'obs-meta-row';
  const dot = document.createElement('span');
  dot.className = 'obs-dot';
  dot.style.background = meta.color;
  metaRow.appendChild(dot);
  metaRow.appendChild(document.createTextNode(metaParts.join(' · ')));
  info.appendChild(metaRow);

  card.appendChild(info);
  return card;
}

let _listOffset = 0;
let _listLoading = false;

async function loadObservations(reset) {
  if (_listLoading) return;
  _listLoading = true;

  const listEl = document.getElementById('obs-list');
  const emptyEl = document.getElementById('list-empty');
  const metaEl = document.getElementById('list-meta');
  const loadMoreBtn = document.getElementById('list-load-more-btn');

  if (reset) {
    _listOffset = 0;
    listEl.innerHTML = '';
    emptyEl.style.display = 'none';
    metaEl.textContent = 'Loading…';
  }
  if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = 'Loading…'; }

  const result = await apiFetch('observations', {
    method: 'POST',
    body: JSON.stringify({ search: _listSearch, categories: _listCategories, offset: _listOffset }),
  });

  _listLoading = false;

  if (!result.ok) {
    metaEl.textContent = `Couldn't load observations: ${result.error || 'unknown error'}`;
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    return;
  }

  const frag = document.createDocumentFragment();
  result.observations.forEach(obs => frag.appendChild(buildObsCard(obs)));
  listEl.appendChild(frag);

  _listOffset = result.nextOffset;

  const hasFilters = Boolean(_listSearch) || _listCategories.length > 0;
  if (result.total === 0) {
    emptyEl.style.display = '';
    document.getElementById('list-empty-text').textContent = hasFilters
      ? 'No observations match your filters.'
      : 'No observations yet — connect and sync from the Overview tab.';
    metaEl.textContent = '';
  } else {
    emptyEl.style.display = 'none';
    metaEl.textContent = `${result.total.toLocaleString()} observation${result.total === 1 ? '' : 's'}${hasFilters ? ' matched' : ''}`;
  }

  if (loadMoreBtn) {
    loadMoreBtn.style.display = result.hasMore ? '' : 'none';
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more';
  }
}

function initListLoadMore() {
  const btn = document.getElementById('list-load-more-btn');
  if (!btn) return;
  btn.addEventListener('click', () => loadObservations(false));
}

// ── Map tab ────────────────────────────────────────────────────────────
let _map = null;
let _clusterGroup = null;
let _flatGroup = null;
let _mapClustered = true;
let _mapLoading = false;

function isMapActive() {
  return document.getElementById('tab-map').classList.contains('active');
}

function taxonMarkerIcon(iconicTaxon) {
  const meta = ICONIC_TAXA[iconicTaxon] || ICONIC_TAXA.Unknown;
  return L.divIcon({
    className: 'obs-marker',
    html: `<span style="background:${meta.color}"></span>`,
    iconSize: [14, 14],
  });
}

// Built via DOM APIs, same reasoning as buildObsCard — this is other iNat
// users' free-text data, not just the signed-in user's own.
function buildMapPopup(point) {
  const wrap = document.createElement('div');
  wrap.className = 'map-popup';

  if (point.thumb) {
    const img = document.createElement('img');
    img.className = 'map-popup-thumb';
    img.src = point.thumb;
    img.alt = '';
    wrap.appendChild(img);
  }

  const name = document.createElement('div');
  name.className = 'map-popup-name';
  name.textContent = point.common_name || point.scientific_name || 'Unknown';
  wrap.appendChild(name);

  if (point.scientific_name && point.common_name) {
    const sci = document.createElement('div');
    sci.className = 'map-popup-sci';
    sci.textContent = point.scientific_name;
    wrap.appendChild(sci);
  }

  if (point.observed_on) {
    const date = document.createElement('div');
    date.className = 'map-popup-date';
    date.textContent = formatDate(point.observed_on);
    wrap.appendChild(date);
  }

  const link = document.createElement('a');
  link.className = 'map-popup-link';
  link.href = `https://www.inaturalist.org/observations/${point.inat_id}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'View on iNaturalist →';
  wrap.appendChild(link);

  return wrap;
}

function initMap() {
  if (_map) return;
  _map = L.map('map-canvas', { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(_map);

  _clusterGroup = L.markerClusterGroup();
  _flatGroup = L.featureGroup(); // not layerGroup — featureGroup adds getBounds(), needed below
  _clusterGroup.addTo(_map); // clustered is the default view

  // Leaflet reads the container's size synchronously at construction time;
  // this is cheap insurance against the classic "gray tiles" bug if the tab
  // panel's display:flex hasn't fully taken effect yet in some browser.
  setTimeout(() => _map.invalidateSize(), 0);
}

// Cluster and individual views need their own separate marker instances —
// Leaflet.markercluster mutates markers it manages (position/visibility) to
// draw clusters, so sharing one instance between MarkerClusterGroup and a
// plain LayerGroup would let clustering effects leak into the flat view.
function renderMapMarkers(points) {
  _clusterGroup.clearLayers();
  _flatGroup.clearLayers();

  for (const point of points) {
    const latlng = [point.latitude, point.longitude];
    const icon = taxonMarkerIcon(point.iconic_taxon);

    const clusterMarker = L.marker(latlng, { icon });
    clusterMarker.bindPopup(() => buildMapPopup(point));
    _clusterGroup.addLayer(clusterMarker);

    const flatMarker = L.marker(latlng, { icon: taxonMarkerIcon(point.iconic_taxon) });
    flatMarker.bindPopup(() => buildMapPopup(point));
    _flatGroup.addLayer(flatMarker);
  }

  const activeGroup = _mapClustered ? _clusterGroup : _flatGroup;
  const bounds = points.length && activeGroup.getBounds();
  if (bounds && bounds.isValid()) {
    _map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  }
}

async function loadMapPoints() {
  if (_mapLoading) return;
  _mapLoading = true;
  document.getElementById('map-meta').textContent = 'Loading…';

  const result = await apiFetch('map', {
    method: 'POST',
    body: JSON.stringify({ search: _listSearch, categories: _listCategories }),
  });

  _mapLoading = false;

  if (!result.ok) {
    document.getElementById('map-meta').textContent = `Couldn't load map: ${result.error || 'unknown error'}`;
    return;
  }

  renderMapMarkers(result.points);

  const hasFilters = Boolean(_listSearch) || _listCategories.length > 0;
  const metaEl = document.getElementById('map-meta');
  if (result.points.length === 0) {
    metaEl.textContent = hasFilters
      ? 'No observations match your filters.'
      : 'No mapped observations yet — connect and sync from the Overview tab.';
  } else {
    metaEl.textContent = `${result.points.length.toLocaleString()} mapped observation${result.points.length === 1 ? '' : 's'}${hasFilters ? ' matched' : ''}`;
  }
}

function initMapClusterToggle() {
  const btn = document.getElementById('map-cluster-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    _mapClustered = !_mapClustered;
    btn.textContent = _mapClustered ? 'Clustered' : 'Individual';
    btn.classList.toggle('active', _mapClustered);

    _map.removeLayer(_mapClustered ? _flatGroup : _clusterGroup);
    _map.addLayer(_mapClustered ? _clusterGroup : _flatGroup);
  });
}

window._bootApp = function (user) {
  initTabs();
  initUserMenu(user);
  initFilterBar();
  initConnectFlow();
  initSyncFlow();
  initStatsToggle();
  initListLoadMore();
  initMapClusterToggle();
  loadProfile();
};

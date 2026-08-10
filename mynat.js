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

function initCategoryChips() {
  document.querySelectorAll('.chip[data-category]').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
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

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.total.toLocaleString();
  document.getElementById('stat-species').textContent = stats.speciesCount.toLocaleString();
  document.getElementById('stat-daterange').textContent = stats.earliest && stats.latest
    ? `${formatDate(stats.earliest)} – ${formatDate(stats.latest)}`
    : '–';

  const breakdown = document.getElementById('category-breakdown');
  breakdown.innerHTML = '';

  if (stats.total === 0) {
    breakdown.innerHTML = '<p class="cat-empty">No observations synced yet.</p>';
    return;
  }

  const maxCount = Math.max(...stats.categories.map(c => c.count));
  for (const { iconic_taxon, count } of stats.categories) {
    const meta = ICONIC_TAXA[iconic_taxon] || ICONIC_TAXA.Unknown;
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <div class="cat-label">${meta.label}</div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(count / maxCount * 100).toFixed(1)}%; background:${meta.color}"></div></div>
      <div class="cat-count">${count.toLocaleString()}</div>
    `;
    breakdown.appendChild(row);
  }
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

window._bootApp = function (user) {
  initTabs();
  initUserMenu(user);
  initCategoryChips();
  initConnectFlow();
  initSyncFlow();
  loadProfile();
};

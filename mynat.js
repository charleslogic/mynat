// MyNat — app logic. Runs after the inline auth module in index.html defines
// window._supabase and calls window._bootApp(user) on sign-in.

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

function renderOverview(profile) {
  const emptyEl = document.getElementById('overview-empty');
  const connectedEl = document.getElementById('overview-connected');
  if (profile) {
    emptyEl.style.display = 'none';
    connectedEl.style.display = '';
    document.getElementById('connected-username').textContent = `@${profile.inat_username}`;
    document.getElementById('connected-sync-status').textContent = profile.last_synced_at
      ? `Last synced ${new Date(profile.last_synced_at).toLocaleString()}`
      : 'Not synced yet — sync lands in Phase 2.';
  } else {
    emptyEl.style.display = '';
    connectedEl.style.display = 'none';
    document.getElementById('connect-form').style.display = 'none';
    document.getElementById('connect-inat-btn').style.display = '';
  }
}

async function loadProfile() {
  const result = await apiFetch('profile');
  if (!result.ok) return;
  renderOverview(result.profile);
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
  }

  submitBtn.addEventListener('click', submitUsername);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submitUsername(); });
}

window._bootApp = function (user) {
  initTabs();
  initUserMenu(user);
  initCategoryChips();
  initConnectFlow();
  loadProfile();
};

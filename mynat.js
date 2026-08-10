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

// Phase 1 wires this button to the real "connect your iNat username" flow
// (resolve username -> inat_user_id via /v1/users/autocomplete, save to
// mynat_profiles). Phase 0 just proves the shell renders and auth works.
function initConnectButton() {
  const btn = document.getElementById('connect-inat-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    alert('Connect flow lands in Phase 1 — see the dev plan.');
  });
}

window._bootApp = function (user) {
  initTabs();
  initUserMenu(user);
  initCategoryChips();
  initConnectButton();
};

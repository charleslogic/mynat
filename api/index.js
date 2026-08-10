const { createClient } = require('@supabase/supabase-js');

// Anon client — used only to validate JWTs
const supabaseAuth = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const COLD_START = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

async function verifyAuth(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) return null;
    return { user, token };
}

// User-scoped client — RLS enforces per-user isolation automatically
function userDb(token) {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: 'Bearer ' + token } }
    });
}

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
    res.setHeader('X-App-Version', sha ? `build ${sha}` : COLD_START);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.query.action === 'version') return res.status(200).json({ ok: true });

    const auth = await verifyAuth(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { token } = auth;
    const db = userDb(token);
    const action = req.query.action || '';

    try {
        switch (action) {

            // Phase 1 adds: profile (get/link iNat username), and Phase 2 adds
            // sync (paginate iNat /v1/observations, upsert into mynat_observations,
            // update mynat_profiles.last_synced_at). See dev plan sections 2-3.

            default:
                return res.status(404).json({ ok: false, error: 'Unknown action' });
        }
    } catch (err) {
        console.error(`[mynat api] action=${action}`, err);
        return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
};

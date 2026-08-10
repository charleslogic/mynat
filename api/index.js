const { createClient } = require('@supabase/supabase-js');

const INAT_API = 'https://api.inaturalist.org/v1';

const COLD_START = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

// Env is read lazily (not at module load) so a missing SUPABASE_URL/ANON_KEY
// can't crash the whole function — including the no-auth `version` action,
// which has no business depending on Supabase being configured at all.
function requireEnv() {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
        throw new Error('Server misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY not set');
    }
    return { url, anonKey };
}

async function verifyAuth(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const { url, anonKey } = requireEnv();
    const supabaseAuth = createClient(url, anonKey);
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) return null;
    return { user, token };
}

// User-scoped client — RLS enforces per-user isolation automatically
function userDb(token) {
    const { url, anonKey } = requireEnv();
    return createClient(url, anonKey, {
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

    const action = req.query.action || '';

    try {
        const auth = await verifyAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

        const { user, token } = auth;
        const db = userDb(token);
        const uid = user.id;

        switch (action) {

            case 'profile': {
                const { data, error } = await db
                    .from('mynat_profiles')
                    .select('inat_username, inat_user_id, last_synced_at, created_at')
                    .eq('user_id', uid)
                    .maybeSingle();
                if (error) throw error;
                return res.json({ ok: true, profile: data || null });
            }

            case 'link-inat': {
                const username = (req.body?.username || '').trim();
                if (!username) return res.status(400).json({ ok: false, error: 'Username required' });
                // iNat usernames are alphanumeric plus - and _ (matches their own signup validation).
                if (!/^[a-zA-Z0-9_-]{1,40}$/.test(username)) {
                    return res.status(400).json({ ok: false, error: 'That doesn\'t look like a valid iNaturalist username' });
                }

                const acResp = await fetch(`${INAT_API}/users/autocomplete?q=${encodeURIComponent(username)}`);
                if (!acResp.ok) throw new Error('iNaturalist API error');
                const acJson = await acResp.json();
                // Autocomplete is fuzzy — only accept an exact (case-insensitive) login match.
                const match = (acJson.results || []).find(u => u.login?.toLowerCase() === username.toLowerCase());
                if (!match) {
                    return res.status(404).json({ ok: false, error: `No iNaturalist user found with username "${username}"` });
                }

                const { data, error } = await db
                    .from('mynat_profiles')
                    .upsert(
                        { user_id: uid, inat_username: match.login, inat_user_id: match.id },
                        { onConflict: 'user_id' }
                    )
                    .select('inat_username, inat_user_id, last_synced_at, created_at')
                    .single();
                if (error) throw error;
                return res.json({ ok: true, profile: data });
            }

            // Phase 2 adds: sync (paginate iNat /v1/observations, upsert into
            // mynat_observations, update mynat_profiles.last_synced_at). See dev
            // plan section 3.

            default:
                return res.status(404).json({ ok: false, error: 'Unknown action' });
        }
    } catch (err) {
        console.error(`[mynat api] action=${action}`, err);
        return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
};

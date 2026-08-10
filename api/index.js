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

// iNat photo URLs come back sized to whatever the endpoint defaults to
// (typically "square") with the size baked into the filename, e.g.
// ".../12345/square.jpg". Other sizes are the same URL with that segment
// swapped — no extra API call needed.
const PHOTO_SIZES = ['square', 'small', 'medium', 'large', 'original'];
function derivePhotoUrls(url) {
    if (!url) return null;
    const m = url.match(/\/(square|small|medium|large|original|thumb)(\.\w+)(\?.*)?$/);
    if (!m) return { url, square: url, small: url, medium: url, large: url, original: url };
    const [, matchedSize, ext] = m;
    const out = { url };
    for (const size of PHOTO_SIZES) {
        out[size] = url.replace(`/${matchedSize}${ext}`, `/${size}${ext}`);
    }
    return out;
}

function mapObservation(obs, uid) {
    const taxon = obs.taxon || {};
    const photos = (obs.photos || []).map(p => derivePhotoUrls(p.url)).filter(Boolean);

    let latitude = null, longitude = null;
    if (Array.isArray(obs.geojson?.coordinates)) {
        [longitude, latitude] = obs.geojson.coordinates;
    } else if (typeof obs.location === 'string') {
        const [lat, lng] = obs.location.split(',').map(Number);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) { latitude = lat; longitude = lng; }
    }

    return {
        inat_id: obs.id,
        user_id: uid,
        taxon_id: taxon.id ?? null,
        scientific_name: taxon.name ?? null,
        common_name: taxon.preferred_common_name ?? null,
        iconic_taxon: taxon.iconic_taxon_name ?? null,
        ancestor_ids: taxon.ancestor_ids ?? null,
        taxon_rank: taxon.rank ?? null,
        observed_on: obs.observed_on ?? null,
        time_observed_at: obs.time_observed_at ?? null,
        latitude,
        longitude,
        place_guess: obs.place_guess ?? null,
        quality_grade: obs.quality_grade ?? null,
        photos: photos.length ? photos : null,
        inat_updated_at: obs.updated_at ?? null,
    };
}

// Shared by 'observations' and 'map' — parses+caps the filter inputs, then
// applies category/search filtering to a query builder. Search uses ILIKE
// rather than the idx_mynat_obs_search tsvector index (full-text tsquery
// syntax is less forgiving for a plain search-as-you-type box); the string
// is sanitized before being interpolated into the .or() filter expression
// since PostgREST's or= syntax treats ,() as structural — left raw, a
// crafted search string could inject additional filter clauses.
function parseFilterInput(body) {
    const search = typeof body.search === 'string' ? body.search.trim().slice(0, 100) : '';
    const categories = Array.isArray(body.categories)
        ? body.categories.filter(c => typeof c === 'string').slice(0, 20)
        : [];
    // Curated shortcut (Butterflies/Moths/etc, see mynat_category_shortcuts)
    // — the client already has the full list cached from action=shortcuts
    // and sends the taxon ID(s) directly rather than the label, so this
    // doesn't need a second DB round trip per filter request. Still
    // type-checked here since it's client-supplied input reaching a query.
    const shortcut = body.shortcut && Number.isInteger(body.shortcut.taxonId)
        ? {
            taxonId: body.shortcut.taxonId,
            excludeTaxonId: Number.isInteger(body.shortcut.excludeTaxonId) ? body.shortcut.excludeTaxonId : null,
        }
        : null;
    return { search, categories, shortcut };
}

function applyObservationFilters(query, { search, categories, shortcut }) {
    if (categories.length) query = query.in('iconic_taxon', categories);
    if (shortcut) {
        // ancestor_ids contains the shortcut's taxon (e.g. Papilionoidea for
        // Butterflies); excludeTaxonId subtracts a nested subgroup for splits
        // that aren't their own clade (Moths = Lepidoptera minus
        // Papilionoidea — verified via live data that this sums correctly:
        // Butterflies + Moths == total Lepidoptera).
        query = query.contains('ancestor_ids', [shortcut.taxonId]);
        if (shortcut.excludeTaxonId) query = query.not('ancestor_ids', 'cs', `{${shortcut.excludeTaxonId}}`);
    }
    if (search) {
        const cleaned = search.replace(/[,()]/g, ' ').trim();
        if (cleaned) {
            const esc = cleaned.replace(/[%_\\]/g, m => `\\${m}`); // escape ILIKE wildcards
            query = query.or(`common_name.ilike.%${esc}%,scientific_name.ilike.%${esc}%`);
        }
    }
    return query;
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

            case 'shortcuts': {
                // Shared reference data, not per-user — see mynat_category_shortcuts
                // in supabase-setup.sql. Curated via the SQL editor, not the app.
                const { data, error } = await db
                    .from('mynat_category_shortcuts')
                    .select('label, taxon_id, exclude_taxon_id')
                    .order('label');
                if (error) throw error;
                return res.json({ ok: true, shortcuts: data });
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

            case 'stats': {
                // Pulls just the 3 columns needed and aggregates in JS rather than
                // relying on PostgREST's group-by/aggregate syntax — simpler and more
                // predictable, and cheap at personal-observation-history scale (low
                // thousands of rows). PostgREST caps an unbounded select at 1000 rows
                // by default, so this pages explicitly past that rather than silently
                // undercounting once an account passes 1000 observations.
                const PAGE_SIZE = 1000;
                const byCategory = {};
                const categorySpecies = {}; // iconic_taxon -> Set(taxon_id), for the species-view toggle
                const speciesSeen = new Set();
                let earliest = null, latest = null;
                let total = 0;
                let offset = 0;

                while (true) {
                    const { data, error } = await db
                        .from('mynat_observations')
                        .select('iconic_taxon, observed_on, taxon_id')
                        .range(offset, offset + PAGE_SIZE - 1);
                    if (error) throw error;

                    for (const row of data) {
                        const key = row.iconic_taxon || 'Unknown';
                        byCategory[key] = (byCategory[key] || 0) + 1;
                        if (row.taxon_id != null) {
                            speciesSeen.add(row.taxon_id);
                            (categorySpecies[key] || (categorySpecies[key] = new Set())).add(row.taxon_id);
                        }
                        if (row.observed_on) {
                            if (!earliest || row.observed_on < earliest) earliest = row.observed_on;
                            if (!latest || row.observed_on > latest) latest = row.observed_on;
                        }
                    }
                    total += data.length;
                    if (data.length < PAGE_SIZE) break;
                    offset += PAGE_SIZE;
                }

                const categories = Object.entries(byCategory)
                    .map(([iconic_taxon, count]) => ({
                        iconic_taxon,
                        count,
                        speciesCount: categorySpecies[iconic_taxon]?.size ?? 0,
                    }))
                    .sort((a, b) => b.count - a.count);

                return res.json({
                    ok: true,
                    stats: { total, speciesCount: speciesSeen.size, earliest, latest, categories },
                });
            }

            case 'observations': {
                const filters = parseFilterInput(req.body || {});
                const offset = Number.isInteger(req.body?.offset) && req.body.offset >= 0 ? req.body.offset : 0;
                const PAGE_SIZE = 30;

                let query = db
                    .from('mynat_observations')
                    .select('inat_id, common_name, scientific_name, iconic_taxon, observed_on, place_guess, photos', { count: 'exact' })
                    .order('observed_on', { ascending: false, nullsFirst: false })
                    .order('inat_id', { ascending: false }) // stable tiebreaker so .range() paging can't skip/repeat rows across same-day ties
                    .range(offset, offset + PAGE_SIZE - 1);
                query = applyObservationFilters(query, filters);

                const { data, error, count } = await query;
                if (error) throw error;

                return res.json({
                    ok: true,
                    observations: data,
                    total: count,
                    nextOffset: offset + data.length,
                    hasMore: offset + data.length < count,
                });
            }

            case 'map': {
                const filters = parseFilterInput(req.body || {});
                const PAGE_SIZE = 1000; // PostgREST's unbounded-select cap — page past it explicitly (see Overview Stats bug)
                const points = [];
                let offset = 0;

                while (true) {
                    let query = db
                        .from('mynat_observations')
                        // thumb: pulls just the square photo URL out of the photos jsonb
                        // array instead of the whole array (5 URLs/row) — the map can have
                        // ~1700+ points in one response, so this keeps payload lean.
                        .select('inat_id, latitude, longitude, iconic_taxon, common_name, scientific_name, observed_on, thumb:photos->0->>square')
                        .not('latitude', 'is', null)
                        .not('longitude', 'is', null)
                        .range(offset, offset + PAGE_SIZE - 1);
                    query = applyObservationFilters(query, filters);

                    const { data, error } = await query;
                    if (error) throw error;
                    points.push(...data);
                    if (data.length < PAGE_SIZE) break;
                    offset += PAGE_SIZE;
                }

                return res.json({ ok: true, points });
            }

            case 'sync': {
                const { data: profile, error: profErr } = await db
                    .from('mynat_profiles')
                    .select('inat_user_id, last_synced_at')
                    .eq('user_id', uid)
                    .maybeSingle();
                if (profErr) throw profErr;
                if (!profile?.inat_user_id) {
                    return res.status(400).json({ ok: false, error: 'Connect your iNaturalist account first' });
                }

                // Fixed for the whole sync session (a run of same-page-window calls
                // from the client) — only written back once the session's last page
                // comes up short, so every call in the session sees the same cutoff
                // regardless of how many round trips it takes.
                const since = profile.last_synced_at;

                const startPage = Math.max(1, parseInt(req.body?.page, 10) || 1);
                const PER_PAGE = 200;
                // Caps each invocation to a handful of iNat requests so a big
                // initial import can't run past Vercel's function time limit — the
                // client just calls again with nextPage until hasMore is false.
                // NOTE: classic page-based pagination on /v1/observations breaks
                // down past page*per_page = 10,000 results (iNat API limitation).
                // Fine for a personal observation history; an account with more
                // than ~10k observations would need id-based (id_above) pagination
                // instead — not implemented here.
                const MAX_PAGES_PER_CALL = 5;

                let imported = 0;
                let lastPage = startPage - 1;
                let hasMore = true;

                for (let i = 0; i < MAX_PAGES_PER_CALL; i++) {
                    const page = startPage + i;
                    const params = new URLSearchParams({
                        user_id: String(profile.inat_user_id),
                        per_page: String(PER_PAGE),
                        page: String(page),
                        order: 'asc',
                        order_by: 'id',
                    });
                    if (since) params.set('updated_since', since);

                    const obsResp = await fetch(`${INAT_API}/observations?${params.toString()}`, {
                        headers: { 'User-Agent': 'MyNat (https://mynat.charleslogic.com)' },
                    });
                    if (!obsResp.ok) throw new Error(`iNaturalist API error (page ${page})`);
                    const obsJson = await obsResp.json();
                    const results = obsJson.results || [];
                    lastPage = page;

                    if (results.length === 0) { hasMore = false; break; }

                    const rows = results.map(o => mapObservation(o, uid));
                    const { error: upsertErr } = await db
                        .from('mynat_observations')
                        .upsert(rows, { onConflict: 'inat_id' });
                    if (upsertErr) throw upsertErr;
                    imported += rows.length;

                    if (results.length < PER_PAGE) { hasMore = false; break; }
                }

                if (!hasMore) {
                    const { error: touchErr } = await db
                        .from('mynat_profiles')
                        .update({ last_synced_at: new Date().toISOString() })
                        .eq('user_id', uid);
                    if (touchErr) throw touchErr;
                }

                return res.json({ ok: true, imported, page: lastPage, nextPage: lastPage + 1, hasMore });
            }

            default:
                return res.status(404).json({ ok: false, error: 'Unknown action' });
        }
    } catch (err) {
        console.error(`[mynat api] action=${action}`, err);
        return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
};

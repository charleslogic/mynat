import { next } from '@vercel/edge';

// Shared abuse gate — ported from famtree's proxy.js (Next.js middleware) to
// plain Vercel Edge Middleware, since this app has no framework at all.
//
// Set SITE_KEY in the environment (Vercel project settings, or .env.local for
// local dev). Anyone visiting with `?k=<SITE_KEY>` is let in and gets a
// long-lived cookie, so it only has to be clicked once per device. Everyone
// else (bots, scrapers, randoms) gets a small "enter the key" page and never
// reaches the app or its Supabase-authenticated login screen. This sits in
// front of the real per-user login (see CLAUDE.md "Access Gate") — it is not
// a replacement for it.
const SECRET = process.env.SITE_KEY;

const COOKIE_NAME = 'mynat_gate';
const ONE_YEAR = 60 * 60 * 24 * 365;

// Activity logging — records who's trying the gate, how often, and what keys
// they're guessing, in the shared Supabase project's gate_log table (see
// gate_log-setup.sql). Fire-and-forget: never blocks or breaks the gate if
// Supabase is unset, slow, or down.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const APP_NAME = 'mynat';

function logGateEvent(context, request, event, keyTried) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    const url = new URL(request.url);
    const promise = fetch(`${SUPABASE_URL}/rest/v1/gate_log`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            prefer: 'return=minimal',
        },
        body: JSON.stringify({
            app: APP_NAME,
            event,
            ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
            country: request.headers.get('x-vercel-ip-country') || null,
            path: url.pathname,
            user_agent: request.headers.get('user-agent') || null,
            key_tried: keyTried ?? null,
        }),
    }).catch(() => {});
    context?.waitUntil?.(promise);
}

// SHA-256 hex via Web Crypto (available in the Edge runtime). We store the
// hash in the cookie rather than the raw key.
async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function getCookie(request, name) {
    const header = request.headers.get('cookie') || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

function gatePage(message) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <link rel="icon" href="/mynat-icon.svg" />
    <title>MyNat</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0D0D12;
        color: #e5e7eb;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        padding: 24px;
      }
      .card {
        background: #14151C;
        border: 1px solid #1F2030;
        border-radius: 16px;
        padding: 32px 28px;
        width: 100%;
        max-width: 360px;
        box-shadow: 0 12px 40px rgba(0,0,0,.5);
        text-align: center;
      }
      h1 { margin: 0 0 6px; font-size: 22px; color: #e5e7eb; }
      p { margin: 0 0 20px; color: #9ca3af; font-size: 15px; line-height: 1.4; }
      input {
        width: 100%;
        padding: 12px 14px;
        font-size: 16px;
        border: 1px solid #1F2030;
        border-radius: 10px;
        margin-bottom: 12px;
        background: #0D0D12;
        color: #e5e7eb;
      }
      input:focus { outline: 2px solid #4CAF7D; border-color: #4CAF7D; }
      button {
        width: 100%;
        padding: 12px 14px;
        font-size: 16px;
        font-weight: 600;
        color: #fff;
        background: #4CAF7D;
        border: 0;
        border-radius: 10px;
        cursor: pointer;
      }
      button:hover { opacity: .85; }
      .msg { color: #f08080; font-size: 14px; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <form class="card" method="GET" action="">
      <h1>MyNat</h1>
      <p>Private space. Enter the key to continue.</p>
      ${message ? `<div class="msg">${message}</div>` : ''}
      <input
        type="text"
        name="k"
        placeholder="Key"
        autocomplete="off"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        autofocus
      />
      <button type="submit">Enter</button>
    </form>
  </body>
</html>`;
}

function gateResponse(message) {
    return new Response(gatePage(message), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    });
}

export default async function middleware(request, context) {
    // Fail open if no key is configured, so local dev or a misconfigured deploy
    // never locks everyone out. Set SITE_KEY in production to arm the gate.
    if (!SECRET) return next();

    const expected = await sha256(SECRET);

    // Already unlocked on this device.
    if (getCookie(request, COOKIE_NAME) === expected) return next();

    const url = new URL(request.url);
    const provided = url.searchParams.get('k');

    if (provided !== null) {
        if (provided === SECRET) {
            logGateEvent(context, request, 'attempt_ok', provided);
            // Correct key: drop the cookie and redirect to a clean URL (no ?k=).
            const clean = new URL(url);
            clean.searchParams.delete('k');
            const res = new Response(null, {
                status: 302,
                headers: { Location: clean.toString() },
            });
            res.headers.append(
                'Set-Cookie',
                `${COOKIE_NAME}=${expected}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`
            );
            return res;
        }
        logGateEvent(context, request, 'attempt_fail', provided);
        return gateResponse("That key didn't match. Please try again.");
    }

    // No cookie and no key supplied.
    logGateEvent(context, request, 'view');
    return gateResponse();
}

export const config = {
    // Run on every request except the icon and manifest, which must stay
    // reachable without the cookie (the icon shows on the locked gate page
    // itself; the manifest is fetched by browsers/OS for "add to home
    // screen" prompts without credentials).
    matcher: ['/((?!mynat-icon.svg|manifest.json).*)'],
};

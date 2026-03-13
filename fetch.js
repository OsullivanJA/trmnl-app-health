/**
 * fetch.js — TRMNL App Health
 *
 * Fetches deployment and error data from Vercel, Sentry, and (optionally)
 * Supabase, then writes the result to data.json for the TRMNL template.
 *
 * Usage:
 *   cp .env.example .env   # fill in your credentials
 *   npm run fetch
 *
 * Requires Node.js >= 18 (native fetch).
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that a set of required environment variables are present.
 * Returns false (with a console warning) if any are missing.
 * @param {string[]} names
 * @param {string} service
 */
function requireEnv(names, service) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.warn(`[${service}] Missing env vars: ${missing.join(', ')} — skipping.`);
    return false;
  }
  return true;
}

/**
 * Wraps a fetch call; throws with a readable message on non-OK responses.
 * @param {string} url
 * @param {RequestInit} options
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

async function fetchVercel() {
  if (!requireEnv(['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'], 'Vercel')) return null;

  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID } = process.env;

  const params = new URLSearchParams({ projectId: VERCEL_PROJECT_ID, limit: '1' });
  if (VERCEL_TEAM_ID) params.set('teamId', VERCEL_TEAM_ID);

  const res = await apiFetch(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });

  const { deployments } = await res.json();
  const d = deployments?.[0];

  if (!d) {
    return { status: 'UNKNOWN', url: null, deployed_at: null, branch: null, commit_message: null };
  }

  return {
    status: d.state ?? 'UNKNOWN',
    url: d.url ? `https://${d.url}` : null,
    deployed_at: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    branch:
      d.meta?.githubCommitRef ??
      d.meta?.gitlabCommitRef ??
      d.meta?.bitbucketCommitRef ??
      null,
    commit_message:
      d.meta?.githubCommitMessage ??
      d.meta?.gitlabCommitMessage ??
      d.meta?.bitbucketCommitMessage ??
      null,
  };
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

/**
 * Parses the Sentry Link response header to determine if a next page exists.
 * @param {string|null} linkHeader
 */
function sentryHasNextPage(linkHeader) {
  if (!linkHeader) return false;
  // Link header format: <url>; rel="next"; results="true"; cursor="..."
  const parts = linkHeader.split(',');
  return parts.some(
    (part) => part.includes('rel="next"') && part.includes('results="true"'),
  );
}

async function fetchSentry() {
  if (!requireEnv(['SENTRY_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'], 'Sentry')) return null;

  const { SENTRY_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;

  const headers = { Authorization: `Bearer ${SENTRY_TOKEN}` };
  const base = `https://sentry.io/api/0/projects/${encodeURIComponent(SENTRY_ORG)}/${encodeURIComponent(SENTRY_PROJECT)}/issues/`;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const unresolvedParams = new URLSearchParams({ query: 'is:unresolved', limit: '100' });
  const newParams = new URLSearchParams({ query: `is:unresolved firstSeen:>${since24h}`, limit: '100' });

  const [unresolvedRes, newRes] = await Promise.all([
    apiFetch(`${base}?${unresolvedParams}`, { headers }),
    apiFetch(`${base}?${newParams}`, { headers }),
  ]);

  const [unresolved, newIssues] = await Promise.all([
    unresolvedRes.json(),
    newRes.json(),
  ]);

  const hasMore = sentryHasNextPage(unresolvedRes.headers.get('Link'));

  return {
    unresolved_count: unresolved.length,
    unresolved_count_capped: hasMore, // true → real count is 100+
    new_24h_count: newIssues.length,
  };
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

async function fetchSupabase() {
  if (process.env.SUPABASE_ENABLED !== 'true') return null;

  if (!requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_TABLES'], 'Supabase')) {
    return null;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_TABLES } = process.env;

  const tables = SUPABASE_TABLES.split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const results = await Promise.allSettled(
    tables.map(async (table) => {
      const res = await apiFetch(
        `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=count`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            Prefer: 'count=exact',
            Accept: 'application/json',
          },
        },
      );

      // Supabase returns the row count in the Content-Range header: "0-0/1234"
      const contentRange = res.headers.get('content-range') ?? '';
      const total = parseInt(contentRange.split('/')[1] ?? '', 10);

      return { name: table, count: Number.isNaN(total) ? null : total };
    }),
  );

  const tables_data = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  results
    .filter((r) => r.status === 'rejected')
    .forEach((r, i) => console.warn(`[Supabase] Table "${tables[i]}" error:`, r.reason?.message));

  return { tables: tables_data };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching app health data…');

  const [vercelResult, sentryResult, supabaseResult] = await Promise.allSettled([
    fetchVercel(),
    fetchSentry(),
    fetchSupabase(),
  ]);

  const settled = (result, label) => {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[${label}] Error:`, result.reason?.message ?? result.reason);
    return { error: result.reason?.message ?? 'Unknown error' };
  };

  const data = {
    fetched_at: new Date().toISOString(),
    vercel: settled(vercelResult, 'Vercel'),
    sentry: settled(sentryResult, 'Sentry'),
    supabase: settled(supabaseResult, 'Supabase'),
  };

  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf8');
  console.log('✓ data.json written at', data.fetched_at);

  // ── Push to TRMNL webhook ────────────────────────────
  const webhookUrl = process.env.TRMNL_WEBHOOK_URL;
  if (webhookUrl) {
    const webhookRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_variables: data }),
    });
    if (webhookRes.ok) {
      console.log('✓ TRMNL webhook updated');
    } else {
      const body = await webhookRes.text().catch(() => '');
      console.error(`[TRMNL] Webhook responded with HTTP ${webhookRes.status}: ${body}`);
      process.exit(1);
    }
  } else {
    console.warn('[TRMNL] TRMNL_WEBHOOK_URL not set — skipping webhook push.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

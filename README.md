# trmnl-app-health

A TRMNL e-ink plugin that displays deployment and error health for a Svelte web app.

| Section | Source |
|---------|--------|
| Deployment status | Vercel Deployments API v6 |
| Unresolved errors / new in 24 h | Sentry Issues API |
| Table row counts *(optional)* | Supabase REST API |

---

## Project structure

```
.github/
  workflows/
    refresh.yml   ← GitHub Actions scheduled job (every 2 h)
.env.example      ← documents required secrets (committed)
.env              ← your actual secrets for local runs (gitignored)
fetch.js          ← Node.js script: fetches APIs → pushes to TRMNL webhook
data.json         ← generated output (gitignored)
template.html     ← TRMNL Liquid markup template
package.json
```

---

## Prerequisites

- A GitHub repository (public or private) to host this project
- A TRMNL account with a **Custom** plugin configured with webhook strategy

---

## TRMNL plugin setup

1. In your TRMNL dashboard create a new **Custom** plugin (webhook strategy).
2. Copy the generated **Webhook URL**.
3. In the plugin editor, paste the contents of `template.html` as the markup.

---

## GitHub Actions setup (automated, every 2 hours)

All secrets are stored as **GitHub Actions repository secrets** — they are never
committed to the repo.

### 1. Add secrets to the repository

Go to **Settings → Secrets and variables → Actions → New repository secret** and
add each of the following:

| Secret name | Where to find it |
|-------------|-----------------|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_PROJECT_ID` | Project → Settings → General |
| `VERCEL_TEAM_ID` | Team → Settings → General *(team projects only — can leave blank)* |
| `SENTRY_TOKEN` | sentry.io → Settings → Auth Tokens (scope: `project:read`) |
| `SENTRY_ORG` | Your organisation slug in Sentry |
| `SENTRY_PROJECT` | Your project slug in Sentry |
| `SUPABASE_ENABLED` | `true` to activate, omit or set `false` to skip |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase project → Settings → API → `service_role` key |
| `SUPABASE_TABLES` | Comma-separated table names, e.g. `users,profiles` |
| `TRMNL_WEBHOOK_URL` | TRMNL plugin → Edit → Webhook URL |

### 2. Push the repository

```bash
git init
git add .
git commit -m "chore: initial scaffold"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

The workflow (`.github/workflows/refresh.yml`) runs automatically on the schedule.
You can also trigger it manually from the **Actions** tab → **Refresh TRMNL App Health** → **Run workflow**.

### Refresh schedule

The default schedule is every 2 hours (`0 */2 * * *` UTC).
Edit the `cron` line in [.github/workflows/refresh.yml](.github/workflows/refresh.yml) to adjust.

---

## Local development / testing

Install dependencies and create a local `.env`:

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run fetch
```

`fetch.js` writes `data.json` and, if `TRMNL_WEBHOOK_URL` is set, immediately
POSTs the payload to the TRMNL webhook.

---

## Supabase notes

- `SUPABASE_SERVICE_KEY` is the **service role** key. It bypasses Row Level
  Security — keep it out of client-side code and never commit it.
- Row counts are fetched via the PostgREST `count=exact` strategy, which reads
  the `content-range` response header.
- Tables inside Supabase's `auth` schema (e.g. `auth.users`) are not accessible
  via the public REST endpoint. Use a view or a Postgres function if you need
  those counts.

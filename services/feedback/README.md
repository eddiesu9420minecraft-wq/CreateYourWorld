# cyw-feedback — CYW Feedback Center backend

Cloudflare Worker (TypeScript) + D1 (records) + R2 (attachments). The API contract is
[`docs/feedback/API.md`](../../docs/feedback/API.md); implementation notes and small deviations are at its end.

**Status: local only.** No Cloudflare account, D1 database, R2 bucket, OAuth app or secret has been created.
`wrangler.toml` holds placeholders. Nothing here deploys anything.

## Layout

| path | what |
|---|---|
| `src/index.ts` | route table, rate-limit wiring, error handling |
| `src/router.ts`, `src/http.ts` | tiny router, JSON responses, bounded body reading (64 KiB JSON) |
| `src/auth.ts` | sessions / service tokens (only SHA-256 stored), roles, bans, guards |
| `src/handlers/*.ts` | auth, feedback (+votes, comments, attachments, notifications), github (link + webhook), releases, tasks, admin |
| `src/redact.ts` | redaction rules (same as the Rust client, minus the local-user-name rule) — `redact(text) -> { text, counts }` |
| `src/attachments-check.ts` | magic bytes, PNG/JPEG/WebP metadata rejection, UTF-8 log check, filename cleaning |
| `src/github.ts` | every outbound GitHub call (device flow, `/user`, issues, comments); `setGitHubFetch()` for tests |
| `src/transitions.ts`, `src/validate.ts`, `src/ratelimit.ts`, `src/crypto.ts`, `src/model.ts` | rules and shared helpers |
| `migrations/0001_init.sql` | D1 schema |
| `test/unit`, `test/api`, `test/security` | vitest suites running in workerd with local D1/R2 |

## Run locally

Requires Node.js (tested with 26.x). Everything is installed inside this folder (own `package.json` / lockfile).

```sh
cd services/feedback
npm ci
npm test            # vitest in the real workerd runtime (@cloudflare/vitest-pool-workers), local D1 + R2
npm run typecheck   # tsc --noEmit
npm run dev         # applies D1 migrations locally, then wrangler dev --local on http://127.0.0.1:8787
```

`npm run dev` runs:

```sh
wrangler d1 migrations apply DB --local
wrangler dev --local --ip 127.0.0.1 --port 8787 --var ENVIRONMENT:development
```

`ENVIRONMENT=development` enables `POST /v1/auth/dev` (`{ "login": "...", "role": "user|developer|maintainer" }`),
which the local end-to-end run uses instead of GitHub sign-in. In any other environment that route is `404`.
Local data lives in `.wrangler/state` (gitignored); delete that folder to start from an empty database.

Optional: copy `.dev.vars.example` to `.dev.vars` for dummy `GITHUB_TOKEN` / `GITHUB_WEBHOOK_SECRET` values.
Without them GitHub sync answers `503 not_configured` and every webhook is rejected with `401`.
`GITHUB_OAUTH_CLIENT_ID` is empty, so `POST /v1/auth/device` answers `503 not_configured` locally.

Quick check:

```sh
curl -s http://127.0.0.1:8787/v1/health
curl -s -X POST http://127.0.0.1:8787/v1/auth/dev -H 'Content-Type: application/json' -d '{"login":"tester"}'
```

## What deployment would need (each step needs the user's explicit approval)

1. A Cloudflare account and `wrangler login`.
2. `wrangler d1 create cyw-feedback` → put the returned `database_id` into `wrangler.toml`.
3. `wrangler r2 bucket create cyw-feedback-attachments`.
4. A GitHub OAuth App with device flow enabled → set its public client id as `GITHUB_OAUTH_CLIENT_ID` in `wrangler.toml`.
5. Secrets: `wrangler secret put GITHUB_TOKEN` (token allowed to create/comment/close issues in the product repos) and
   `wrangler secret put GITHUB_WEBHOOK_SECRET`; set `GITHUB_BOT_LOGIN` to the login that owns `GITHUB_TOKEN`.
6. Check `MAINTAINER_LOGINS` and `PRODUCTS` in `wrangler.toml`; keep `ENVIRONMENT = "production"`.
7. `wrangler d1 migrations apply DB --remote`, then `wrangler deploy`.
8. In each product repo: add a webhook to `https://<worker>/v1/github/webhook` (JSON, the secret from step 5,
   events: issue comments, issues, releases).

The service never publishes releases: `POST /v1/releases` only records a release a human already published, and needs
a maintainer session with `human_approved: true`.

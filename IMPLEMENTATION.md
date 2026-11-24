# MIRAS AI implementation status

## Implemented on feature branch

- XAUUSD-only symbol normalization with safe broker suffix support.
- Supabase latest-snapshot migration and repository.
- Compact `/api/market/latest` status response.
- Supabase-authenticated analysis creation, history, and report APIs.
- Gemini client with server-only key, structured JSON mode and Zod validation.
- Adaptive Protective/Standard/Deep selection.
- Deterministic entry and risk validation module.
- QStash stage callbacks, signature verification, stage leases and persistent stage results.
- Daily QStash budget reservation migration.
- Manual-only Telegram report endpoint and duplicate delivery record.
- RTL MIRAS dashboard, login page and analysis/history UI.
- Existing MT5 ingestion remains on 5-second EA behavior.

## Not executed

- Supabase migrations were not applied.
- Vercel settings were not changed.
- Vercel production was not deployed.
- Upstash settings were not changed.
- Gemini key/model was not validated against a real account.
- QStash signing keys were not configured or tested.
- Telegram credentials were not activated.

## Required setup

1. Create Supabase Auth users.
2. Configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Apply migrations `003_miras_live_snapshot.sql` and `004_miras_analysis_jobs.sql` to the target Supabase project.
5. Configure and verify a Gemini Free Tier model explicitly.
6. Configure QStash token and signing keys.
7. Configure Telegram Bot credentials.
8. Set `APP_URL` to the preview or production origin.
9. Review and deploy from the feature branch only.

## Free-tier constraints

- EA remains at 5 seconds.
- Redis is not used for the latest snapshot ingest path.
- Analysis reserves Standard 10 and Deep 16 worst-case QStash messages.
- Application usage stops at 800 reserved messages/day.

# TODO

## Security & Auth
- Move session secret, admin seed password, and JSON body limit to `.env` with clear defaults and fail-fast if missing in production.
- Add rate limiting on auth endpoints and per-instance APIs.
- Add CSRF protection for session-based routes (or switch to token-based auth for the UI).
- Add password policy + password change flow for users.
- Add audit log for admin actions (create/delete instance, API key reset).

## Instance Lifecycle
- Persist instance metadata beyond `instances.json` (SQLite table) and add migrations.
- Add auto-reconnect/backoff strategy and surface reconnect reason in UI.
- Add instance “pause/disable” state without deleting session data.
- Add a background cleanup for stale sessions and orphaned LocalAuth folders.

## Messaging & Media
- Add API to send media (file URL/base64) with MIME validation and size limits.
- Add message pagination + filters (by sender, group, date range) in API + UI.
- Add message deduping safeguards and visibility for duplicate detection events.
- Add retention policy (e.g., keep N days) and manual purge by instance.

## Webhooks & Integrations
- Add signed webhook delivery with retries and dead-letter log.
- Add per-instance webhook config (URL, secret, enabled events).
- Add outbound rate limiting to avoid webhook flooding.

## UI/UX
- Add user management UI (create user, assign instances, reset password).
- Add instance list search + status filter + bulk actions.
- Add message log export (CSV/JSON) from UI.
- Add empty states and error boundary components for websocket failures.

## Observability
- Add structured logging with request ids and instance ids.
- Add basic metrics (active instances, websocket clients, message rate).
- Add health check endpoint and readiness probe for deployments.

## Data & Backups
- Add automated DB backup/restore scripts and document them.
- Add migration tooling/version table for schema changes.
- Add WAL checkpoint scheduling or configurable interval.

## DevEx & Testing
- Add linting + formatting (ESLint/Prettier) and pre-commit hooks.
- Add unit tests for db helpers and auth flows.
- Add integration tests for core APIs + websocket events.
- Add CI workflow (test + lint + build UI).

## Deployment
- Add Dockerfile + docker-compose (app + volume for sessions + DB).
- Add production config guide (reverse proxy, HTTPS, env vars).
- Add graceful shutdown handling for WhatsApp clients.

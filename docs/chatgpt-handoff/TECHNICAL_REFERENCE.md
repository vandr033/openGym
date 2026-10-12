# openGym Technical Reference

Snapshot: 2026-10-12, branch main, commit e8ef703.  
Source code and checked-in workflows are primary evidence. Product docs are cross-checked where practical.

## Architecture and repository map

~~~text
api/                  Node HTTP API, JSON persistence, auth, media, push, Coach
  coach/              provider config, adapters, jobs, prompts, validation
frontend/             React/Vite client and Capacitor Android/iOS projects
  src/views/           Home, Plan, Workout, Stats, History, Settings, Admin, Coach
  src/lib/             training rules, imports, sync, health, media, progression
  src/store/           Zustand profile and UI state
  src/components/      shared UI
  src/locales/         UI translations
mcp/                  optional local read-only Model Context Protocol server
web/                  Nginx Docker image and API reverse proxy
website/              static project website and API/docs pages
docs/                 user, hosting, mobile, AI and developer guides
kubernetes/            single-replica deployment example and persistent volumes
scripts/               catalog, translation, docs and Coach asset generators
.github/workflows/     tests, images, Pages demo and GitLab mirror
.gitlab-ci.yml         mirrored checks and release artifacts
~~~

### Runtime communication

1. Browser/PWA loads static assets from Nginx. React uses HashRouter screens including Home, Plan, Workout, Stats, History, Library, Muscles, Structural Balance, Settings and optional Coach/Admin.
2. Nginx proxies /api to Node. This keeps browser WebAuthn on one origin. Paired Capacitor clients use bearer tokens and mobile fetch code.
3. API reads/writes JSON and media under DATA_DIR. It also owns in-memory challenges, pairing codes, caches, reminder/presence state, and Coach job coordination.
4. Optional MCP stdio process is launched separately by an LLM client and reads one selected profile’s files.
5. Optional outbound integrations include Web Push, AI providers, Hevy imports, and iOS HealthKit.

Sources: frontend/src/App.jsx, frontend/src/lib/api.js, frontend/src/lib/mobile.js, api/server.js, web/nginx.conf.template, mcp/src/index.js.

### Technology and versions

Versions are manifest ranges, not resolved installed versions.

| Area | Implementation |
|---|---|
| UI | React/React DOM ^19.2.7, React Router ^7.18.2 |
| State | Zustand ^5.0.14 with custom persistence |
| Build | Vite ^8.1.5, React plugin ^6.0.3 |
| API | Node 22 Alpine in Docker; built-in node:http |
| API packages | @simplewebauthn/server, undici, web-push; optional Claude Agent SDK |
| Native app | Capacitor 7, iOS Swift plugins and Android native code |
| MCP | @modelcontextprotocol/sdk and Zod |
| Web server | Nginx Alpine |
| Persistence | JSON files; no database driver or ORM |
| Website | Static HTML/CSS/JavaScript |

Sources: package.json files, Dockerfiles and frontend/capacitor.config.json.

## Key files

| Path | Responsibility |
|---|---|
| README.md | Product, feature summary, quick start and config |
| CLAUDE.md | Existing development context |
| frontend/src/main.jsx and frontend/src/App.jsx | Client entry, app boot and route composition |
| frontend/src/store/useStore.js | Default profile shape, persistence, pairing and sync |
| frontend/src/store/useUI.js | Ephemeral UI state |
| frontend/src/lib/progression.js | Progression policies and targets |
| frontend/src/lib/session-start.js | Build session entries from plan/history |
| frontend/src/lib/finish-workout.js | Persisted shape for a completed workout |
| frontend/src/lib/history.js | Session/history read logic and calculations |
| frontend/src/lib/sync-merge.js | Field-aware state merge and reset semantics |
| frontend/src/lib/health/ | HealthKit bridge, normalization and sync |
| frontend/src/views/ | User-facing screens |
| frontend/src/sheets.jsx | Shared editors and sheets |
| api/server.js | HTTP routes, sessions, state writes, admin, push and CSRF |
| api/openapi.yaml | Hand-maintained OpenAPI 3.1 contract |
| api/media.js | Upload validation, quotas, disk storage and GC |
| api/health-data.js | Health data schema validation and per-profile files |
| api/coach/routes.js | Coach route group |
| api/coach/jobs.js | File-backed jobs, proposals, caps and restart handling |
| api/coach/core/ | Provider-neutral payload, prompt, schema, validation and parsing |
| api/coach/adapters/ | HTTP, Claude, Codex and fixture adapters/security boundary |
| mcp/src/index.js | MCP stdio startup |
| mcp/src/state.js and mcp/src/tools.js | File reads/profile selection and read-only tools |
| web/nginx.conf.template | API proxy, upload limits, headers and cache rules |
| docker-compose.yml and api/Dockerfile | Default stack, persistent mounts, optional Coach target |
| kubernetes/deployment.yaml | One-replica sample deployment |
| .github/workflows/test.yml and .gitlab-ci.yml | CI, release and packaging |

## Persistence and logical data model

There is no SQL database, ORM, or formal application migration directory. The runtime uses JSON files under DATA_DIR. The relationships below are conceptual; there are no SQL foreign keys/indexes.

| File/object | Meaning |
|---|---|
| db.json | Users, WebAuthn credentials, push subscriptions, invites and device-link records. Rows reference profile IDs. |
| state-<uid>.json | Per-profile routines/programs/week/date overrides, completed workouts, body weight, preferences, custom exercises and sync metadata such as _rev/_ts/resetAt. Active sessions are removed from server writes. |
| health-<uid>.json | Separate Apple Health daily and workout summaries, authenticated by profile. |
| uploads/<uid>/ | Profile-owned media named by content hash; profile JSON stores references. |
| audit.log | JSON Lines sign-in/admin events; IP details are off unless enabled. |
| secret | HMAC session key and key material used to encrypt Coach credentials. Losing it revokes sessions and prevents decrypting those credentials. |
| vapid.json | Web Push key pair. |
| coach.json | Instance Coach config and encrypted provider credentials. |
| coach/<uid>.json | Per-profile Coach job, pending proposal and history. |
| coach-auth-<uid>.json and /coach-auth | Per-profile/runtime provider credential files/caches; Codex cache is intentionally outside normal data backup path. |

~~~mermaid
erDiagram
  USER ||--o{ WEBAUTHN_CREDENTIAL : owns
  USER ||--o{ PUSH_SUBSCRIPTION : registers
  USER ||--o{ INVITE : creates_or_uses
  USER ||--|| PROFILE_STATE : owns
  USER ||--o| HEALTH_DATA : owns
  USER ||--o| COACH_STATE : owns
  PROFILE_STATE ||--o{ ROUTINE : contains
  PROFILE_STATE ||--o{ PROGRAM : contains
  PROFILE_STATE ||--o{ WORKOUT : records
  PROFILE_STATE ||--o{ BODYWEIGHT_ENTRY : records
  ROUTINE }o--o{ EXERCISE : references
  WORKOUT }o--o{ EXERCISE : records
  EXERCISE_MEDIA }o--|| USER : belongs_to
~~~

This is a logical map, not a relational schema. Application code checks IDs and relationships. The API strictly validates Health payloads and media, and validates the outer state document/list shapes; most nested profile fields remain app-defined.

### Atomicity and sync

- JSON writes use a temporary file plus rename.
- PUT /api/data accepts baseRev. A stale revision returns 409 with current state; the client merges/retries.
- Comparison/write is synchronous in one process. Kubernetes uses one API replica; multiple processes sharing DATA_DIR are not shown as supported.
- Reset stamps/IDs prevent an old device or backup from restoring records removed by a reset.
- Sync merge unions records by IDs and edit stamps, merges body weight by day, and chooses some settings by recency. Full delete tombstones do not exist; concurrent deletes can be resurrected.
- Media GC removes unreferenced files after a grace period. Workout/profile retention is user-controlled; no automatic workout age deletion was found.

**INFERRED RISK** — Single JSON documents, whole-profile writes, the 5 MB request limit and no cross-process lock constrain growth and horizontal scaling. Database storage appears in ROADMAP.md but is not implemented here.

## HTTP API groups

The full hand-maintained contract is api/openapi.yaml; implementation is api/server.js plus api/coach/routes.js. Routes return JSON except media content.

| Group | Representative routes | Auth and purpose |
|---|---|---|
| Health/config/session | GET /api/health, GET /api/config, GET /api/me | Public health/config; session introspection |
| Registration/sign-in | POST /api/register/options, POST /api/register/verify, POST /api/login/options, POST /api/login/verify | WebAuthn challenges; invite rules can gate registration |
| Password/account | /api/login/password, /api/register/password, /api/account/password, /api/account/email | Routes only exist when PASSWORD_LOGIN is enabled |
| Passkeys/pairing | /api/account/passkeys, /api/account/device-link, /api/device-link/*, /api/pair/* | Owner-authenticated passkey management and short-lived one-time phone pairing |
| Profile sync | GET/PUT /api/data, GET /api/data/rev | Profile owner; revision-aware whole-state synchronization |
| Health | GET/PUT /api/health-data | Authenticated, separate HealthKit document |
| Media | PUT/GET /api/media/{hash}, /api/media/missing, /api/media/sweep | Authenticated owner file access; config/routes disappear when uploads disabled |
| Push/presence | /api/push/*, POST /api/activity | Authenticated subscription, test/rest alert and active session presence |
| Admin | /api/admin/* | Admin-only history/operations/invites/audit/Coach configuration |
| AI Coach | /api/coach/* | Signed-in plus Coach enabled/connected; consent, caps and provider credential policy |

### Authentication/security boundaries

- WebAuthn public credential data/counter are stored server-side; authenticator private keys stay with the authenticator.
- Session payload carries profile, expiry and version, signed with HMAC. HTTPS uses Secure host-only cookies; sign-out-everywhere increments version.
- Mobile pairing creates a short-lived one-use code and bearer token for the app.
- Password login is optional, scrypt-hashed and throttled; password endpoints are absent when disabled.
- Admin checks are enforced in API handlers.
- Mutating browser requests are checked against Fetch Metadata/Origin; mobile bearer requests and WebAuthn/pairing ceremonies have separate rules.
- No universal request rate limit was found. Sign-in/password and media have targeted limits.
- Push endpoints must use HTTPS and resolve outside private/local addresses.
- Nginx adds framing/content-type/referrer headers and a frame-ancestors policy; TLS/HSTS are expected from the external proxy.

Sources: api/server.js, api/password.js, api/rate-limit.js, api/media.js, web/nginx.conf.template.

## Implementation patterns

- Zustand store overlays saved state onto defaults to keep older profiles readable. See DEF and boot/persist in frontend/src/store/useStore.js.
- Training math, progression, import matching, history, unit conversion and sync merge live under frontend/src/lib.
- Starting a planned session resolves routine-slot history/policy and keeps planned vs selected target separate.
- Finished workout records contain completed work, not live session bookkeeping.
- Coach proposal application is local, validated, snapshot-backed and reversible; user workout history is out of scope.
- Media uses content-hash references; binary upload/download state lives outside the synced state blob.
- HealthKit reads are iOS-native and normalized/cached before optional server sync.

## Integrations

### Exercise data/media
Exercise metadata and instructions are bundled from upstream-derived data. Docker Compose/Kubernetes can fetch images/GIFs into persistent media storage. The images/GIFs have separate licensing; see NOTICE.md.

### AI Coach
Provider definitions are in api/coach/core/providers.js and api/coach/config.js. HTTP providers include Anthropic, OpenAI, Gemini and OpenAI-compatible endpoints. Optional adapters invoke Claude Agent SDK or Codex CLI. Default API image omits those runtimes; api/Dockerfile has an opt-in Coach target. Phone BYOK stores keys in platform secure storage where native storage exists. See docs/AI_COACH.md and api/coach/core/.

### Hevy, HealthKit and Push
- Hevy import is user-triggered, not continuous synchronization.
- HealthKit is iOS-only. Optional server sync sends normalized summaries/workouts, not raw heart-rate samples.
- Web Push contacts subscription endpoints. The API validates URLs and DNS results before outbound traffic.
- MCP uses local stdio, not API authentication.
- No email delivery provider or email-sending workflow was found in the reviewed integration paths.

## Environment configuration names

Names and purpose only; no actual environment values are copied. Consult .env.example, README.md, api/openapi.yaml and hosting guides for defaults.

| Area | Names | Purpose |
|---|---|---|
| API/storage | PORT, DATA_DIR, ORIGIN, RP_ID, RP_NAME, SESSION_DAYS | Listener, storage, public origin/passkey identity and session lifetime |
| Account access | ADMIN_UIDS, INVITE_ONLY, ALLOW_GUEST, PASSWORD_LOGIN, DEFAULT_LANG, TRUST_PROXY | Admins, registration/guest policy, optional password, default language, trusted proxy address for throttling |
| Audit/push | AUDIT_LOG, AUDIT_MAX, AUDIT_DAYS, AUDIT_IP, VAPID_SUBJECT | Audit enablement/retention/IP detail and push contact subject |
| Media | MEDIA_UPLOADS, MEDIA_QUOTA_MB, MEDIA_IMAGE_MAX_MB, MEDIA_GIF_MAX_MB, MEDIA_VIDEO_MAX_MB, MEDIA_VIDEO_MAX_SEC, MEDIA_GC_GRACE_DAYS, MEDIA_UPLOADS_PER_HOUR, MEDIA_MIN_FREE_MB, MEDIA_UPLOAD_MAX | Media feature, quota/file limits, GC/rate/disk floor and Nginx body limit |
| Coach | COACH_DISABLED, COACH_JOB_TIMEOUT_MS, COACH_CREDENTIAL_DIR, API_TARGET | Kill switch, timeout, credential cache, Docker target |
| Web/deployment | WEB_PORT, NGINX_PORT, BACKEND, RESOLVER, BASE_PATH, CF_CONNECTING_IP | Host/listener/upstream/DNS/subpath/Cloudflare forwarding |
| Frontend/dev build | VITE_MOBILE, VITE_DEMO, VITE_IMG_BASE, VITE_GIF_BASE, API_ORIGIN, MEDIA_TARGET, VITE_UMAMI_SRC, VITE_UMAMI_ID | Mobile/demo build, media bases, dev proxies and optional site analytics |
| MCP | OPENGYM_DATA, OPENGYM_UID | Local data path and chosen profile |
| Internal/test | BODY_TIMEOUT_MS, REMINDER_TICK_MS, STATE_CACHE_TTL_MS, FIXTURE_MODE, TMPDIR, APP_BUILD | Timeouts/cache/test fixture/temp/build metadata |

## Development and CI

Commands are defined in package scripts and CONTRIBUTING.md; none were run in this analysis.

| Goal | Command |
|---|---|
| Local containers | cp .env.example .env; docker compose up -d --build |
| Frontend dev/tests/build | cd frontend; npm run dev; npm test; npm run build |
| Frontend locales | cd frontend; node scripts/check-locales.mjs |
| API tests/start | cd api; npm test; npm start |
| MCP tests/loadability | cd mcp; npm test; npm run check:node-loadable |
| Capacitor build/sync | cd frontend; npm run build:mobile |

GitHub Actions runs frontend tests/build/locale/additional checks, MCP tests/loadability, API tests/assets/core checks, and Docker image build/boot checks. GitLab CI handles release packaging and mirrored artifacts. CONTRIBUTING.md says pull requests use these pipelines. Do not treat configuration as a test result.

## Deployment and operations

- Compose runs a one-shot exercise media download, API and Nginx. Profile state is bind-mounted; exercise media uses separate mounts.
- API and web images use Node 22 Alpine and Nginx Alpine. Default API excludes AI runtime; optional target adds it.
- TLS termination is expected at a reverse proxy/tunnel or Kubernetes Gateway. RP_ID/ORIGIN must match external host.
- API health endpoint is /api/health; web health check is /. Kubernetes defines readiness/liveness probes, Recreate and one API replica with persistent volumes.
- Preserve DATA_DIR, secret, VAPID keys, Coach files and uploads. The Codex auth cache is outside the normal data archive.
- No built-in database backup, object store, failover or multi-replica write coordination was found.

Sources: docker-compose.yml, docker-compose.coolify.yml, api/Dockerfile, web/Dockerfile, kubernetes/, docs/SELF_HOSTING.md, docs/SELF_HOSTING_KUBERNETES.md.

## Source-of-truth order

1. Current code and tests.
2. api/openapi.yaml, cross-checked with API route code.
3. User/operator docs, cross-checked against source.
4. CHANGELOG.md for release/unreleased history.
5. ROADMAP.md for proposals, not proof of shipped behavior.


# openGym Project Context

Analysis snapshot: 2026-10-12  
Repository: openGym, branch main, commit e8ef703. This is a repository snapshot, not a live deployment report.

## Project identity

**openGym** is an open-source, self-hosted gym and body-weight tracker. It helps people plan routines, run guided workouts, record sets and body weight, and review progress. Its product goal is to keep workout data under the operator’s control while offering offline use, device sync, passkey sign-in, and phone-friendly screens.

The project is distributed as a self-hosted web app/PWA and standalone Android/iOS Capacitor apps. A standalone app can keep data on the phone without an openGym server. One self-hosted instance can serve multiple personal profiles. No organization, company tenant, or SaaS subscription model exists in the analyzed implementation.

The repository describes the project as free, AGPL-3.0-or-later software. Exercise media has separate third-party licensing; see README.md and NOTICE.md.

**VERIFIED** — Product and deployment model are supported by README.md, docs/MOBILE.md, docs/SELF_HOSTING.md, frontend/src/store/useStore.js, and deployment files.

## Users and roles

| Actor | Purpose and access | Evidence |
|---|---|---|
| Guest/local user | Uses a local-only browser or standalone phone profile. Data stays on that device and does not use the server profile API. An operator can disable guest entry. | **VERIFIED** — frontend/src/store/useStore.js, frontend/src/lib/guest.js, api/server.js |
| Signed-in profile owner | Owns one profile and manages its routines, workouts, weigh-ins, settings, media, passkeys, and connected devices. API access is scoped to the authenticated profile. | **VERIFIED** — api/server.js, frontend/src/store/useStore.js |
| Instance administrator | Operational visibility and controls over profiles, invites, audit, and Coach configuration. Can inspect workout history/body weight, disable or delete other profiles, and reset passwords when enabled. Admin comes from ADMIN_UIDS or an admin flag in the user record. | **VERIFIED** — api/server.js, README.md, docs/SELF_HOSTING.md |
| Instance operator | Runs containers, configures origin/storage/integrations, and owns backup/recovery responsibilities. This is an operational responsibility, not an application role. | **VERIFIED** — docker-compose.yml, docs/SELF_HOSTING.md |
| Trainer/organization admin | No such role was found in current code. A trainer role appears in roadmap material only. | **DOCUMENTED_ONLY** — ROADMAP.md |

New profiles are not automatically admins. A fresh instance defaults to open sign-up and no admin; an operator registers a profile and configures its account ID in ADMIN_UIDS (or sets an admin flag). Admins are a trusted boundary because they can inspect other profiles.

## Product modules and status

Status labels describe repository evidence, not whether a test suite passed during this analysis. **IMPLEMENTED_VERIFIED** means implementation and related tests or CI checks exist; no tests/builds were executed here.

| Module | Status | Capabilities and source paths |
|---|---|---|
| Accounts, passkeys, device pairing | **IMPLEMENTED_VERIFIED** | WebAuthn signup/login, multiple passkeys, optional password login, one-time mobile pairing, session revocation, optional invite-only signup. api/server.js, api/password.js, api/passkeys-store.js, api/device-link.js |
| Planning and routines | **IMPLEMENTED_VERIFIED** | Exercise library/search, routine editor, weekly/date schedules, program blocks/phases, equipment profiles, routine import/share/print. frontend/src/views/Plan.jsx, frontend/src/views/RoutineEdit.jsx, frontend/src/lib/routines.js, frontend/src/lib/programs.js, frontend/src/lib/routine-import.js |
| Guided workouts and history | **IMPLEMENTED_VERIFIED** | Guided set logging, rest timers, warmups, supersets, timed/cardio work, workout notes, readiness/discomfort logging, history edit/backfill. frontend/src/views/Workout.jsx, frontend/src/lib/session-start.js, frontend/src/lib/finish-workout.js, frontend/src/lib/session-edit.js |
| Progression and analytics | **IMPLEMENTED_VERIFIED** | Linear, Greyskull LP, double and timed progression; estimated 1RM, muscle balance/recovery, activity, body-weight charts, Structural Balance. frontend/src/lib/progression.js, frontend/src/lib/onerm.js, frontend/src/lib/history.js, frontend/src/lib/muscles.js, frontend/src/lib/structuralBalance.js |
| Catalog and custom exercises | **IMPLEMENTED_VERIFIED** | Bundled exercise data/instructions, translations, custom exercises, optional owner media and links. frontend/src/lib/exercises.js, frontend/src/lib/exercises-data.js, frontend/src/views/Library.jsx, api/media.js |
| Import/export/backup | **IMPLEMENTED_VERIFIED** | CSV, FitNotes/Strong/Hevy, Hevy API, Apple Health export, JSON backup, routine JSON, focused training export, plan sharing. docs/DATA_IMPORTS.md, docs/AI_TRAINING.md, frontend/src/lib/import-csv.js, frontend/src/lib/import-hevy.js, frontend/src/lib/training-export.js |
| AI Coach | **IMPLEMENTED_VERIFIED**, optional | Admin-configured provider or phone BYOK. Creates/reviews/debriefs routines and weekly plans; consent and user approval required. It cannot edit workout history or settings. api/coach/, frontend/src/lib/coach.js, frontend/src/views/CoachChat.jsx, docs/AI_COACH.md |
| Apple Health | **IMPLEMENTED_VERIFIED** on iOS | Reads iOS HealthKit summaries/workouts; separate opt-in upload for paired phones. Web and Android do not call HealthKit. An unstaged native plugin change was noted during the initial survey; at final quality control no tracked diff remained. See PROJECT_STATUS.md. frontend/src/lib/health/, frontend/ios/App/App/HealthKitPlugin.swift, api/health-data.js, docs/MOBILE.md |
| Push/reminders | **IMPLEMENTED_VERIFIED** | Web Push and native rest alerts/reminders. api/push-messages.js, frontend/src/lib/push.js, frontend/src/lib/rest-alert.js |
| Admin/audit | **IMPLEMENTED_VERIFIED** | User/history inspection, disable/delete, invites, password reset, audit and Coach controls. frontend/src/views/Admin.jsx, frontend/src/views/AdminCoach.jsx, api/server.js |
| MCP bridge | **IMPLEMENTED_VERIFIED**, read-only | Local stdio tools inspect one profile’s routines, sessions, weight, 1RMs, planned sessions, and muscle balance. mcp/src/, mcp/README.md |
| Website/deployment | **IMPLEMENTED_VERIFIED** as checked-in configuration | Static site/demo, Docker, Kubernetes example, GitHub Actions and GitLab mirror pipeline. website/, .github/workflows/, .gitlab-ci.yml, docker-compose.yml, kubernetes/ |

**PLANNED / DOCUMENTED_ONLY**: roadmap and MCP README describe future database storage, advanced programming, OIDC, trainer tools, MCP writes, HTTP transport, Health Connect and further catalog/mobile work. Some roadmap entries overlap with features already present. See PROJECT_STATUS.md.

## Technology and architecture

- Frontend: React 19, React Router 7, Zustand 5, Vite 8, JavaScript modules.
- API: Node.js 22 runtime and built-in node:http server. No Express or web framework.
- Authentication: @simplewebauthn/server; optional password login uses Node crypto scrypt.
- Persistence: JSON files in a mounted directory. No SQL/NoSQL database, ORM, or formal database migration layer found.
- Push: web-push/VAPID.
- Native clients: Capacitor 7, Android Java project, iOS Swift plugins.
- MCP: @modelcontextprotocol/sdk, Zod, stdio transport.
- Web serving: Nginx serves the static client and proxies /api to the API.
- Tests: Vitest in the frontend and MCP packages; Node built-in test runner for API.

Sources: frontend/package.json, api/package.json, mcp/package.json, Dockerfiles, docker-compose.yml.

~~~mermaid
flowchart LR
  client["Browser / PWA / Capacitor app"]
  web["Nginx static web + API proxy"]
  api["Node HTTP API"]
  files["Mounted JSON files and uploaded media"]
  media["One-shot exercise media download"]
  coach["Optional AI provider"]
  mcp["Optional local read-only MCP process"]
  client -->|"same-origin HTTPS or paired Bearer token"| web
  web -->|"/api"| api
  api --> files
  media --> web
  api -. "configured, consented Coach jobs" .-> coach
  files -. "local filesystem access" .-> mcp
~~~

**VERIFIED** — docs/diagrams/architecture.mmd and container configs show the deployed shape. Optional imports and native APIs are omitted from the diagram for readability.

The browser app keeps a local copy and syncs a profile document to the API. The API stores account/credential metadata separately from each profile’s state. Binary user media and Apple Health data are also separate. The MCP process is not in Compose; it reads the data directory under the local OS account that launches it.

## Important business rules

1. The workout log is the record of completed work. Progression is derived from history; plan targets and session targets remain distinct.
2. Progression is per routine slot/exercise where possible. Double progression adds load only after every normal working set reaches the range ceiling. Warmups, unfinished sets, deload work, and excluded work do not count as ordinary progression.
3. In-progress sessions are device-local. Completed sessions are written to profile history.
4. Cross-device pushes use a server revision. Stale pushes return current state for merge instead of silently replacing another device’s write.
5. An unanswered “adopt this device’s work?” decision blocks sync, so local/guest work is not sent into an account without the user’s choice.
6. Coach proposals are bounded, validated, checked for stale plan edits, and applied by the user on the client. Coach does not write profile state directly.
7. Apple Health server sync is separately opt-in. Turning it off stops future uploads but does not delete data already uploaded.
8. User media is owner-scoped and separate from profile JSON; it is not included in plan sharing. Media is not encrypted at rest.
9. Ordinary users access their own profile. Admins are a trusted, wider-access role.

Sources: frontend/src/lib/progression.js, frontend/src/lib/session-start.js, frontend/src/lib/finish-workout.js, frontend/src/store/useStore.js, frontend/src/lib/sync-merge.js, api/server.js, frontend/src/lib/coach.js, docs/MOBILE.md.

## Integrations

- WebAuthn authenticators: RP_ID and ORIGIN bind passkeys to the served host.
- Web Push: API contacts browser/device subscription endpoints over HTTPS and rejects private/local targets.
- Coach providers: Anthropic, OpenAI, Gemini, OpenAI-compatible endpoints including local Ollama; optional Claude Agent SDK and Codex CLI runtime adapters; fixture provider for tests.
- Exercise metadata/media: metadata/instructions are bundled; Docker/Kubernetes can fetch upstream images/GIFs to persistent storage. Media rights are separate from code licensing.
- Hevy API import and Apple Health/HealthKit are user-triggered flows.
- MCP-compatible clients spawn a local stdio process.
- VITE_UMAMI_SRC and VITE_UMAMI_ID can configure optional website analytics. Whether production sets them is **UNKNOWN**; repository docs say the app has no default telemetry.

Sources: api/coach/core/providers.js, api/server.js, frontend/src/lib/import-hevy.js, frontend/src/lib/health/, docker-compose.yml, frontend/vite.config.js, mcp/README.md.

## Security and data boundaries

**VERIFIED** — Server sessions are HMAC-signed with expiry/version and carried in an HttpOnly, SameSite cookie; HTTPS enables Secure/host-only behavior. Mobile clients use signed bearer tokens. Mutating browser requests use same-origin checks. Password login is optional and uses scrypt/throttling. Admin routes enforce authorization server-side.

**VERIFIED** — Profile data/media paths are profile-scoped. API files are not encrypted at rest. The server stores public passkey credential data, not authenticator private keys. Coach runtime child processes use an unprivileged user and reduced environment; privilege drop fails closed.

**INFERRED RISK** — Anyone who can read the mounted data directory can access profile JSON and uploaded media. Backups need the same care as live storage.

**UNKNOWN** — Production TLS/proxy configuration, live provider settings, active user count, backup success, and actual analytics configuration.

## Key implementation choices

Observed patterns, not formal ADRs: pure training helpers live under frontend/src/lib; Zustand owns frontend profile state; the API uses a single-process JSON-file design and atomic rename writes; profile sync uses revisions and client-side field-aware merge; Coach is isolated/optional; MCP is local read-only; user applies Coach changes locally.

## Terminology

- **Profile**: one user account and training data boundary.
- **Routine**: reusable exercise prescription.
- **Week plan**: weekday-to-routine-ID list; a day can combine routines.
- **Day override**: date-specific schedule change/rest precedence.
- **Program block**: date-based phases and phase schedules.
- **Active workout**: unfinished device-local session.
- **Workout history**: completed records synced as profile data.
- **Progression policy**: rule deriving a next target from plan and history.
- **Coach proposal**: validated, pending suggestion held separately until accepted/dismissed.
- **Revision/baseRev**: server profile version and client’s expected version for a conditional write.

## Unknowns

No product-owner interview or live instance was available. Actual user counts, retention goals, production provider choice, backup practice, uptime goals, and deployment security cannot be determined from the repository. The initial HealthKit file observation and final clean tracked-file status, plus unexecuted tests/builds, are described in PROJECT_STATUS.md and HANDOFF_INDEX.md.


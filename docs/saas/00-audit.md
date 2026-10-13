# Phase 0: Multi-tenant SaaS audit

**Status:** audit and proposal only; no implementation started  
**Audited:** 2026-10-12  
**Checkout:** branch `multitenant`, commit `0210760a23982518e7990ab8c2a24372c13b94a9`

## Executive summary

The checkout is a working single-user-first OpenGym application. Its profile, workout history, and settings are stored as a whole JSON document and synchronized with a per-user revision check. An active workout is deliberately device-local. The API has authentication and useful modular route patterns, but there is no SQL database, Prisma, WebSocket server, or collaborative workout model in the current checkout.

The safe architecture is additive: retain the current profile JSON flow for personal data and solo workouts, and build collaborative sessions as distinct, client-owned SQL records. A trainer receives access only through a current organization membership, client relationship, and client-authorized scope. Each write must be checked against a version, recorded with an idempotency key, and appended to an ordered server event log in one database transaction. WebSocket delivery should notify and replay those committed events; it must not become the source of truth.

Do not copy collaborative sessions into `S.workouts` and send them through `/api/data`. The whole-profile sync and whole-workout merge semantics cannot protect independently edited sets, and can overwrite or resurrect stale data. A later combined-history read/export adapter should join personal JSON history and collaborative SQL history without making the personal JSON writer authoritative for SQL records.

The smallest safe Phase 1 is tenant identity, organization membership, client enrollment, trainer-client relationships, explicit client grants, invitations, and tenant audit events. It does not deliver collaborative workout editing yet. Keep it behind a default-off feature flag and additive migrations; do not import or mutate historical workout data in this phase.

## Scope and checkout state

The approved architecture/product input is `docs/multitenant/OPENGYM_MULTI_TENANT_CODEX_SPEC.md` (read in full). The companion `docs/multitenant/OPENGYM_CODEX_START_PROMPT.md` was also reviewed. Both direct Phase 0 only. The source repository state was inspected rather than assuming the handoff snapshot represented the checkout. The root `CLAUDE.md` was read; no repository `AGENTS.md` was found.

`HEAD` matches the spec's referenced SHA, but the checked-out branch is `multitenant`, not `main`. `git status --short --untracked-files=all` showed only these pre-existing untracked inputs:

- `docs/multitenant/OPENGYM_CODEX_START_PROMPT.md`
- `docs/multitenant/OPENGYM_MULTI_TENANT_CODEX_SPEC.md`

Those files were left untouched. This audit is the only file added. No production database, deployment, account, or workout data was accessed or changed.

The seven documents under `docs/chatgpt-handoff/` describe a prior checkout at `e8ef703`; they are historical context, not evidence of current code. In particular, their HealthKit implementation description does not match this checkout.

## Current system and recommended disposition

| Area | Current implementation and evidence | Disposition for SaaS |
|---|---|---|
| Authentication | `api/server.js:452-538` validates signed cookie sessions, session version/revocation, disabled users, and paired-phone bearer tokens. WebAuthn and login routes are in `api/server.js:1891-2059`; phone pairing is at `2063+`. | Reuse authentication and the existing user ID as a legacy identity mapping. Add a distinct SQL `User` mapping; do not copy credentials or infer tenant access from login. Keep guest/local users outside tenant membership until a deliberate account-claim flow exists. |
| Existing admin | `api/server.js:36-74, 522-538, 2373-2455` supports `ADMIN_UIDS`, user `admin`, broad user inspection, disable, and deletion. | Do not equate this with organization administration or `PlatformAdmin`. Add narrowly scoped tenant permissions. Define how existing admin deletion/deactivation affects mapped identities before enabling SQL identity. |
| Profile storage | `api/server.js:101-151` reads and atomically replaces `db.json` and `state-<uid>.json`; there is no SQL storage layer. `api/package.json` has no MySQL, Prisma, or WebSocket dependency. | Retain profile JSON for current personal data and backward compatibility. Add an independent Prisma/MySQL store for tenant records and collaborative workouts. Do not dual-write collaborative records through the profile endpoint. |
| Profile synchronization | `frontend/src/store/useStore.js:402-560` persists the whole profile, debounces `PUT /api/data`, uses `_rev`/`baseRev`, polls revisions, and merges profile JSON. `api/server.js:2100+` implements the data endpoints; `PUT` removes `body.state.active` and conditionally checks `_rev` at `2162+`. | Keep for personal state. Whole-profile CAS is useful for the existing document, but it is not per-set concurrency control and must not back collaborative edits. |
| Active workout state | `frontend/src/store/useStore.js:26+` uses `gym_state_v1`; profile defaults include `active:null` (`74-88`). `S.active` is kept local through `mergeInto` (`492-510`) and is excluded from server profile data. `frontend/src/lib/mobile.js:1-78` persists an app-local state file and optional paired remote state. | Preserve the solo/offline lifecycle. Give collaborative sessions separate server IDs, local snapshots, and a durable operation queue; never place pending collaborative writes in the profile JSON push path. |
| Workout UI and lifecycle | `frontend/src/views/Workout.jsx` (~97 KB) reads/mutates `S.active` throughout. `frontend/src/sheets.jsx:2749-2786` builds and starts sessions; `3510-3570` computes PRs, builds completed history, clears active state, and saves a backup. | Reuse the workout UI and its controls. Refactor at a narrow data boundary into a session adapter/store, incrementally; do not fork or rewrite the large view. Keep the current start/finish path for solo workouts. |
| Planning and progression | `frontend/src/lib/session-start.js` builds planned entries from `history.js`, `progression.js`, and plate logic. `frontend/src/lib/progression.js:264-323,384+` and `history.js` derive progression from completed `S.workouts`. | Reuse pure planning/progression logic where feasible. Add a combined-history projection before collaborative completions influence progression or exports. Until then, keep collaborative completion/history behind a feature gate or exclude it explicitly from existing consumers. |
| Set representation | `frontend/src/lib/workout-model.js:158-243,265-323` models warmup/work `phase` separately from set `type`, per-side data, drops, and clusters. `frontend/src/lib/history.js:446-588` handles reps, timed/cardio rows, warmups, drops, and rest-pause clusters. `history.js:72-90` supports fractional RIR/RPE. | Preserve these semantics through a versioned server payload and round-trip tests. The proposed SQL base fields alone do not cover them; use typed fields for queryable values and validated versioned JSON for variable method details, or add typed child rows if querying those details becomes required. |
| History merge | `frontend/src/lib/sync-merge.js:307-444` unions histories by workout ID, but when the same completed workout exists on both copies it chooses a whole-workout `_ts` winner. It has no collaborative per-set merge/tombstone contract. | Keep it for legacy personal JSON. Replace it as the authority for collaborative data with per-entity CAS plus append-only events. Do not silently “last timestamp wins” on collaborative sets. |
| Backup/import/export | `frontend/src/views/Settings.jsx:146-156` exports `JSON.stringify(useStore.getState().S`; `useStore.js:1030+` checks imports and `1052+` applies backup imports. `frontend/src/lib/training-export.js:63-92,139+` reads `state.workouts`; routine import uses `opengym-routine-v1` (`frontend/src/lib/routine-import.js:7`). | Preserve current contracts. Add an explicit combined-history export/read adapter with stable source IDs and deduplication. A profile backup import must never overwrite or delete SQL collaborative history implicitly. Keep routine backup format versioned and compatible. |
| Other history consumers | Coach cadence/jobs use JSON state (`api/coach/cadence.js`, `api/coach/jobs.js`); admin endpoints inspect JSON history; MCP reads `state-uid.json` (`mcp/src/state.js`, `mcp/src/tools.js`). | Inventory each consumer before enabling SQL completions in the user-facing history. Either provide a shared combined-history service or explicitly keep these consumers scoped to legacy personal history until migrated. |
| Native/offline | `frontend/src/lib/api.js:22-55` adds bearer auth for paired mobile; `frontend/src/lib/remote.js:1-55` redeems and stores a paired token; mobile state remains locally durable. There is no current WebSocket client. | Reuse pairing and offline local persistence. Native WebSocket clients cannot rely on browser cookie behavior or arbitrary Authorization headers; issue a short-lived, single-use socket ticket over authenticated REST, then re-check session and grants for every command. |
| HealthKit | No HealthKit plugin, health-data route, or health library exists in this checkout. `api/test/server-admin-delete.test.js:78-86` expects `/api/health-data` to return 404. `ROADMAP.md` lists HealthKit as planned. | Treat handoff HealthKit claims as stale. Do not add, remove, or migrate health data as part of this SaaS work. |
| Deployment | `api/Dockerfile:32-61,91-96` builds an API-specific Node 22 image. `docker-compose.yml:35-64` bind-mounts `./data`; `docker-compose.coolify.yml:42-85,146-150` uses volumes but has no MySQL service. | Add a separately managed MySQL service/volume and migration step for SaaS. Keep JSON volumes intact. Do not run schema migrations automatically during every API start. |
| Proxy and API contract | `web/nginx.conf.template:18-54` proxies `/api/` over HTTP/1.1 without WebSocket upgrade headers. `api/openapi.yaml` is hand-maintained; `api/test/openapi-routes.test.js` and `scripts/build-api-docs.mjs` enforce route/spec parity. | Reuse the current HTTP server and modular route factory pattern. Add explicit WS proxy/upgrade handling and Coolify deployment checks. Update OpenAPI and route parity tests with each REST endpoint. |

## Architecture and schema validation

### Tenant and permission model

The spec's separation of global identity, organization membership, client enrollment, trainer-client relationship, and client-authorized access grant is necessary to meet the requirements. Users can have memberships in multiple organizations; an independent trainer can own an organization; a client can enroll in multiple gyms and maintain multiple coaching relationships. Do not encode “gym client” or “trainer” as one global user role.

For every read, write, and socket command that exposes client data, require all of:

1. An authenticated, enabled user identity.
2. An active membership in the relevant organization when the action is organization-scoped.
3. An active trainer-client relationship for that client and trainer/organization.
4. A current, unexpired client grant covering the exact resource/action scope.

Organization enrollment or `owner/admin` role alone must not expose client workouts. A client grant must be revocable, attributable, auditable, and checked on every operation; do not trust a grant cached at socket connection time. Leaving an organization should revoke that path of access without deleting client-owned history. `PlatformAdmin` must be an explicit separately provisioned capability, not a projection of `ADMIN_UIDS` or the legacy `user.admin` flag.

The proposed schema needs two explicit additions before it is frozen:

- An `OrganizationInvitation`/relationship invitation entity. The current `db.invites` are instance signup invites, not tenant invitations. For the first release, a one-use, expiring random token stored as a hash and manually shared is sufficient; do not make Phase 1 depend on email delivery. Acceptance must bind to the authenticated account and re-check inviter authority.
- An append-only `AuditEvent` for membership, invitation, relationship, grant, admin, and access lifecycle changes. `WorkoutEvent` alone cannot audit tenant administration.

Define whether a revoked scope is reactivated or a new grant version is created. A uniqueness rule on `(relationshipId, scope)` can work only if the lifecycle preserves prior revocations and a regrant is distinguishable in the audit trail. Enforce organization/client consistency across relationship, grant, and session references with composite constraints where possible, and repeat authorization in application policy checks.

### Collaborative workout data

Keep workout sessions owned by the client. A trainer edits on the client's behalf only under the current grant. A suggested minimum record set is `WorkoutSession`, `SessionExercise`, `WorkoutSet`, `ClientActiveSession`, `WorkoutOperation`, and `WorkoutEvent`, plus tenant identity/permission records. The session stores a structural `sessionVersion`, lifecycle status, and `lastEventSeq`; each set stores an independent `version` and a deletion tombstone. The active-session slot must be unique per client and created/released transactionally with session status changes.

Additional model details required by the current workout data:

- Preserve reps, timed holds, cardio duration/speed, warmup phase, work-set type, sides, drops, rest-pause clusters, RIR and RPE, notes/discomfort, targets, program/deload/readiness metadata, and units/timezone. `phase` and `type` are different fields in the existing model. Add an explicit `rpe`; it is not interchangeable with `rir`.
- Store weight as canonical `DECIMAL` (for example, MySQL `DECIMAL(10,3)`), not binary floating point, and convert at the client boundary. Record or derive the client's unit preference and local session date/timezone; trainer and client may use different display units.
- Use a versioned, validated JSON payload only for method-specific details that are not queried independently. Its schema version and round-trip behavior must be tested. Keep common queryable values typed. Avoid lossy conversion of side-specific loads/reps or cardio speed units.
- Add composite foreign-key/unique constraints so a `ClientActiveSession` cannot point to a session for another client. Separate valid foreign keys to a user and a session do not by themselves prove they belong together.

MySQL/InnoDB and Prisma are a reasonable fit for the modular Node API. MySQL unique indexes permit multiple `NULL` values, so a unique `(sessionExerciseId, plannedSetSlotId)` can enforce uniqueness for assigned slots while allowing multiple ad-hoc rows with no slot; validate the slot against the exercise on the server. Pin a Prisma major version and generated client in implementation. Use Prisma transactions for each write and production migration workflow rather than app-startup schema mutation. References: [MySQL 8.4 `CREATE TABLE`](https://dev.mysql.com/doc/refman/8.4/en/create-table.html), [Prisma MySQL connector](https://docs.prisma.io/docs/orm/v7/core-concepts/supported-databases/mysql), [Prisma transactions](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions).

### Concurrency, idempotency, and event delivery

The proposed optimistic-concurrency approach is sound with these refinements:

- A set command supplies `expectedSetVersion`, actor, stable client operation ID, and canonical payload. Update with a compare-and-swap condition (`id` plus expected version); mismatch returns `409` with the current authorized row/version. Independent sets can be edited without a logical conflict.
- Structural operations (add/reorder exercise, finish, session-level changes) check `expectedSessionVersion`. Increment the session version when structure/status changes; do not make every set edit conflict with a session-level version check.
- Scope an idempotency key to session and actor; store a canonical request hash. Exact retries return the original result, while the same key with a different payload returns `409`. A unique operation constraint and the mutation/event must commit atomically.
- Allocate `eventSeq` atomically while locking/updating the parent session row. Commit the mutation, operation receipt, and event in one short DB transaction; notify sockets only after commit. Retry only transient deadlock/serialization failures, boundedly, and return a conflict rather than silently dropping a write.
- Completion must race safely with set writes. In one transaction, compare the session cursor/status and transition `ACTIVE` to `COMPLETED`; a late set write must see non-active status and fail. `expectedSessionVersion` alone is insufficient if ordinary set edits only advance set version/event sequence.
- Keep tombstones for deletions so offline replay cannot resurrect a deleted set. Include actor and reason/source where appropriate in events.

WebSocket is transport, not storage. The existing Node HTTP server has no upgrade handler; Node's HTTP `upgrade` event exposes a raw socket and protocol handling is the application's responsibility ([Node 22 HTTP API](https://nodejs.org/download/release/latest-jod/docs/api/http.html)). Use a maintained WebSocket library rather than hand-implementing framing. Subscribe with a cursor and replay committed events from MySQL so reconnects recover gaps. Return a snapshot with `lastEventSeq`, then replay strictly after that cursor to avoid a snapshot/subscription race. Strictly validate browser `Origin` at the upgrade boundary; current REST CSRF/origin checks do not secure WebSockets.

For native clients, obtain a short-lived single-use socket ticket through existing authenticated REST, send it in the first socket auth frame (not in a URL where it can be logged), and then authorize each command. A connected socket must be closed or lose its subscription when a session is revoked, the account is disabled, the relationship ends, or a grant expires/revokes. Enforce payload, rate, subscription-count, and idle limits.

One API replica can initially publish in-process notifications while using the database event log for replay. This is correct only while one replica serves a session; before horizontal API scaling, introduce a shared pub/sub adapter (for example Redis) and test cross-replica delivery. Database event replay remains authoritative either way. Nginx and the Coolify proxy path both need WebSocket upgrade support and timeouts that allow long-lived connections.

### Legacy history and personal data

There is no safe one-step “move JSON to MySQL” migration. Existing JSON histories feed progression, session planning, exports, stats, home, coach jobs, admin inspection, and MCP. `sync-merge.js` merges a completed workout as a whole by timestamp, while full JSON backup import can replace profile state. Automatically projecting SQL rows into `S.workouts` risks stale profile writes overwriting SQL data, duplicate histories, or a backup import appearing to delete collaborative records.

Recommended migration sequence:

1. Keep all existing personal history and profile backups in JSON with current semantics. Add no legacy workout backfill in Phase 1.
2. Store collaborative sessions only in SQL and give them stable source IDs. Do not mirror them into the JSON profile writer.
3. Add a combined-history read adapter that returns personal JSON and SQL collaborative history as separate source-backed records. Make history, stats, progression, training exports, coach jobs, admin, and MCP either consume this adapter or explicitly stay on personal history until a later PR.
4. Update JSON export/import to preserve its existing format and define an explicit versioned combined export/import contract. Import must not overwrite server-owned SQL records. Include stable IDs and source-aware deduplication.
5. Only if product needs historical JSON records in SQL, add a separately reviewed, idempotent dry-run importer with counts, mapping, retry/resume, and no delete step. Validate every existing set type and compare progression and export results before enabling it. Do not silently convert all personal records into trainer-visible records.

The spec's historical migration needs a clear ownership rule: personal history is private to its existing account until the owner explicitly grants access. A relational backfill must never imply consent to share history with a gym or trainer.

### Mobile, offline, and deployment

Keep existing local-only mobile mode, paired-phone authentication, local state file, imports/exports, and solo offline workout use. Collaborative offline work needs a separate durable per-session queue containing operation ID, actor, expected version/cursor, and payload; replay must use the same server CAS and idempotency rules as online writes. Display conflicts for user resolution. Do not rebase conflicting trainer/client edits silently. A local snapshot can support viewing while offline, but cannot grant authority to write after access is revoked.

The API image has explicit copy/build steps, and compose/Coolify currently have no MySQL. A future DB change must touch `api/package.json` and lockfile, Prisma schema/migrations/generated client build, `api/Dockerfile`, local and Coolify compose, secrets/env documentation, persistent DB volume/health check, migration job, restore procedure, and CI. Keep DB off the public network. Back up and restore SQL consistently alongside the existing `data/` files; test restore before production cutover. Do not make the API container's startup path silently migrate a production database.

## Risks and implementation dependencies

| Risk | Consequence | Required control/dependency |
|---|---|---|
| SQL records enter whole-profile JSON sync | Stale device can overwrite or duplicate collaborative data. | Separate repository and API; combined read/export projection only. |
| Membership mistaken for consent | Cross-tenant disclosure of client workouts. | Require active relationship plus explicit scoped grant on every REST and socket operation; IDOR tests. |
| Existing admin privileges reused | `ADMIN_UIDS` can become an unbounded tenant-data bypass. | Separate `PlatformAdmin` provisioning/audit and explicit policy. |
| Finish races with set writes | Completed session changes after totals/history were calculated. | Transactional status/cursor check; reject commands after completion. |
| Socket authorization cached | Revoked trainer retains access. | Reauthorize every command and close subscriptions on revocation/expiry. |
| JSON-specific consumers miss SQL history | Progression, exports, coach, MCP, or admin show inconsistent records. | Combined-history inventory and adapters before broad completion rollout. |
| Existing backups omit SQL | Restoring JSON alone loses collaborative data. | Coordinated DB/profile backup policy and tested restore before launch. |
| API replicas diverge in socket events | Trainer/client see stale updates across replicas. | One-replica launch limit or shared pub/sub before scaling. |
| Guest/account identity transition is ambiguous | Duplicate users or orphaned relationships. | Define authenticated account claim/merge path; no tenant mapping to ephemeral local identity. |
| Legacy admin deletion bypasses SQL lifecycle | Orphaned user mapping or accidental cascade loss. | Block or safely deactivate/revoke mapped identity; never cascade-delete workout ownership. |
| HealthKit handoff is stale | Work may target a non-existent feature or disturb current 404 behavior. | Treat actual checkout as source of truth; no HealthKit work in this plan. |

## Proposed files and existing touch points

These are proposed paths for later PRs, not files created in Phase 0.

| Phase | New files | Existing files likely touched |
|---|---|---|
| 1: identity and permissions | `api/prisma/schema.prisma`, `api/prisma/migrations/*`, `api/saas/db.js`, `api/saas/identity.js`, `api/saas/policy.js`, `api/saas/invitations.js`, `api/saas/audit.js`, `api/saas/routes.js`, `api/scripts/provision-platform-admin.js`, `api/test/saas-*.test.js` | `api/package.json` and lockfile, `api/server.js` (small route wiring only), `api/openapi.yaml`, `api/Dockerfile`, `docker-compose.yml`, `docker-compose.coolify.yml`, `.env.example` or equivalent deployment docs, CI workflow. |
| 2: server-authoritative session REST | `api/saas/workout-routes.js`, `api/saas/workout-service.js`, `api/saas/workout-repository.js`, `api/saas/workout-validation.js`, `api/test/workout-session-*.test.js` | API route wiring/OpenAPI; `frontend/src/lib/session-start.js`, `finish-workout.js`, `workout-model.js`, `history.js`, and a new `frontend/src/lib/collaborative-session.js`; narrow adapter seam in `Workout.jsx` and `sheets.jsx`. |
| 3: realtime and offline queue | `api/saas/workout-socket.js`, `api/saas/socket-ticket.js`, `frontend/src/lib/collaborative-queue.js`, socket and queue tests | `api/server.js` upgrade hook, `web/nginx.conf.template`, Coolify proxy/deployment config, `frontend/src/lib/api.js`, `remote.js`, mobile persistence. |
| 4: trainer/client workflow | focused trainer/client views and state selector modules under `frontend/src/views/` and `frontend/src/lib/`; UI tests | Existing navigation, workout view adapter, responsive/native behavior, accessible conflict UI. |
| 5: history/progression/import/export | `frontend/src/lib/combined-history.js`, API history projection as needed, migration dry-run script only if approved | `history.js`, `progression.js`, `training-export.js`, Settings import/export, `sync-merge.js` boundaries, coach jobs/cadence, admin, MCP readers. |
| 6: production operations | deployment/backup/restore runbook and operational checks | Docker/Coolify, CI, health/readiness, metrics, backup/restore, scale topology. |

Keep Phase 1 modules small and injected into the current route factory style. `api/server.js` already wires `coachRoutes` by passing JSON, body parsing, session, and admin dependencies (`2542+`); follow that pattern instead of replacing the large server. Keep `Workout.jsx` as a view with an adapter boundary rather than rewriting the full component.

## Phased PR proposal

1. **Phase 0 — audit (this PR):** document current state, design checks, risks, Phase 1 boundary, and required tests. No product code or schema changes.
2. **Phase 1 — tenant identity and permission foundation:** additive MySQL/Prisma tables for mapped users, explicit platform admin, organizations, memberships, client enrollment, trainer-client relationship, scoped grants, invitations, and audit events. Feature flags default off. Identity mapping is lazy/idempotent on authenticated SaaS entry. No workout/session tables are required until Phase 2; no history import. Keep existing JSON-only operation healthy if the flag is off or MySQL is unavailable.
3. **Phase 2 — collaborative session REST vertical slice:** create/read/start/complete client-owned sessions, read snapshots, add/edit/delete set commands, operation receipts, CAS, event sequence, unique active-session slot, and role/grant enforcement. Support multiple active client sessions per trainer from the first server API; session IDs and permissions must not be keyed to one trainer-global active workout. Reuse a pure planning adapter; either bring the minimum versioned plan snapshot into this phase or constrain the first slice to a validated freestyle/existing client-generated snapshot. Do not expose collaborative completions to progression until Phase 5's history projection is ready.
4. **Phase 3 — WebSocket replay and offline reconciliation:** socket tickets, strict Origin, cursor subscriptions, durable event replay, per-session mobile queue, visible conflict resolution, and revocation handling. DB event log remains authoritative.
5. **Phase 4 — trainer/client UI:** a trainer console can open and switch among multiple clients/sessions; client and trainer can edit different or same sets concurrently; conflicts show the current value and preserve both attempted values for resolution. UI must not optimistically claim server success before acknowledgement.
6. **Phase 5 — history and progression compatibility:** combine personal JSON and collaborative SQL history for display/export, preserve backup/routine import contracts, then enable progression effects. Audit all coach/admin/MCP readers. Consider a dry-run legacy importer only as a separate explicit product/data decision.
7. **Phase 6 — production hardening and scale:** tested backup/restore, alerts/audit retention, capacity and socket limits, multi-replica pub/sub if needed, and billing only after core workout permissions and history behavior are stable.

The dependency that must not be hidden is Phase 2 versus Phase 5: a collaborative session may be completed before combined history exists. Until the combined projection covers history, stats, progression, exports, coach, admin, and MCP, either hold completion behind the feature flag or keep it visible in a dedicated collaborative history surface without altering legacy progression. Do not let different consumers silently report different totals.

## Smallest safe Phase 1 deliverable

**Deliverable:** behind default-off `SAAS_ENABLED`, an authenticated existing account can be mapped idempotently to a SQL identity, create or join an organization using a one-use invitation, enroll a client in an organization, establish a trainer-client relationship, and create/revoke a narrowly scoped client access grant. All actions are tenant-authorized and audited. No workout data is read or written through this feature.

### Acceptance criteria

- One identity may hold memberships in multiple organizations, including independent trainer organizations; membership roles are organization-scoped.
- A client can enroll in multiple gyms and have active coaching relationships with multiple trainers/organizations at once.
- Signup/passkey/password and paired bearer auth resolve the same mapped user for the same legacy UID; repeated mapping creates no duplicate. Guest/local-only identity is not silently promoted.
- Enrollment or org-admin status does not expose client records. An active relationship and a matching, unexpired client grant are both required for access. Revoking either blocks the next REST request immediately.
- Invitations are random, stored hashed, expire, are single-use, bind acceptance to the authenticated user, and cannot be accepted by an unauthorized or disabled account. Tenant invite tokens do not bypass `INVITE_ONLY` account signup policy.
- `PlatformAdmin` is provisioned separately and is never inferred from `ADMIN_UIDS` or legacy `user.admin`.
- Cross-tenant identifier substitution returns a non-disclosing denial; tenant audit entries identify actor, target, organization, action, and timestamp without storing credentials or raw invite secrets.
- New schema migration is additive and idempotent under the chosen migration workflow. The API does not migrate at every startup. Feature flag off preserves current JSON behavior; the JSON service remains usable when MySQL is down and SaaS is disabled.
- Existing passkey login, password login where configured, session revocation, phone pairing, solo/offline workout, profile revision sync, JSON backup/import, routine import, and native builds remain compatible.
- Existing legacy user deletion/deactivation cannot silently cascade-delete a mapped identity or future client-owned history; define a safe revoke/disable path before enabling mapping for users subject to that endpoint.

### Required tests before Phase 1 merge

- Unit tests for membership/relationship/grant policy, expiry, revocation, role boundaries, and non-disclosing cross-tenant denial.
- MySQL integration tests against the supported MySQL version for migrations, unique constraints, transaction boundaries, invitation single-use under concurrent acceptance, identity upsert idempotency, and audit creation. SQLite-only substitutes are not sufficient for MySQL uniqueness/transaction semantics.
- API tests for all authentication modes that can reach the SaaS routes, same-user identity mapping, default-off behavior, DB-unavailable behavior with flag off, tenant invite/signup-policy interaction, and legacy admin separation.
- OpenAPI route parity test for every new endpoint. Add migration/seed setup to CI using a disposable MySQL service; tests must not point at production or a developer's configured database.
- Run the existing API suite and frontend unit/build/native build checks required by CI. No existing tests should be rewritten to weaken legacy behavior. Add regression assertions that `/api/data` still strips `active`, retains revision conflicts, and does not contain SQL collaboration state.
- Deployment acceptance: clean database migration, repeat migration deploy, API image build/boot with SaaS off, Coolify/local compose health check and persistent volume, and a documented backup/restore rehearsal before production enablement.

Phase 1 does **not** meet the collaborative workout product requirements on its own. The full requirement is not satisfied until Phases 2–5 implement multi-session server authority, simultaneous set editing with visible conflicts, durable reconnect/replay, trainer/client UI, and complete history/progression/import/export integration.

## Phase 0 checks and limits

The selected API checks were started with `node --test test/server-config-session.test.js test/server-data-rev.test.js test/server-data-rev-endpoint.test.js test/server-data-reset.test.js test/server-admin-delete.test.js test/openapi-routes.test.js`. The OpenAPI route parity test passed. Server tests that bind to `0.0.0.0` failed with sandbox `listen EPERM`; that is an environment restriction, so their product assertions were not verified here. A targeted frontend Vitest command covering session start, finish, progression, workout model, sync merge, store sync, and `Workout.jsx` was started, but its completion result was not recoverable from the tool session. Treat it as unverified, not passed. No tests were added or source code changed.

**Not checked:** live MySQL/Prisma behavior, WebSocket proxy behavior, Coolify deployment, backup restore, or mobile hardware behavior; these require Phase 1+ implementation and an appropriate disposable environment. **Known risk:** the API integration test result is limited by sandbox socket permissions, and the frontend test result is inconclusive.

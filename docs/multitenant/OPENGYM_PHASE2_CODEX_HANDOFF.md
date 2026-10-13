# Codex handoff — OpenGym SaaS Phase 2: transactional collaborative workouts

**Repository:** `vandr033/openGym`  
**Branch:** `multitenant` (NEVER modify or merge `main` for this task)  
**Deployment validated at:** `1854564f78199f62367a262597bbbd266b6e8253` (2026-10-13)  
**Current live staging:** Hetzner/Coolify resource `w59c2417ne4bnanjv23z7r0t`, native MySQL database `opengym_saas`, no Compose MySQL service.  
**Status:** design/handoff only; Phase 2 changes are not implemented or deployed by this document.

## Instructions to Codex

Implement **Phase 2 only** as a reviewable, feature-flagged vertical slice. Inspect the actual checked-out code and dirty files first, read `CLAUDE.md` and the canonical `docs/multitenant/OPENGYM_MULTI_TENANT_CODEX_SPEC.md` and `docs/saas/00-audit.md`, and compare against this handoff. Treat code as authoritative if stale handoff text conflicts with it. Ask before changing approved product behavior or dropping data. Do not rewrite the legacy auth stack, the large workout view, the profile JSON sync engine, or native mobile integration just to implement this phase.

**Do not deploy migrations, run destructive tests on live `opengym_saas`, push to `main`, or enable Phase 2 production flags.** Report actual tests, changes, risks, unimplemented elements and rollback instructions. Phase 1 contains working tenant identity, organization membership, invitation flow, client enrollment, trainer-client relationships, explicit permission grants and audit logging. Preserve these contracts.

## 1. Current verified baseline

- API: `api/server.js`, Node `node:http`, signed cookie sessions, passkeys, optional passwords, paired mobile bearer auth, legacy JSON `DATA_DIR` for users and workout state. `api/saas/routes.js` supplies `/api/v2` tenant routes and `api/saas/policy.js` contains `canAccessClientScope`.
- ORM: Prisma `7.10.0` and MySQL (MariaDB adapter for runtime); `api/prisma/schema.prisma`. Migration target `api/Dockerfile:migrate`. Current checked-in migration `20261013000000_saas_identity`. Database schema has tenant identity, grants, invitations and append-only tenant audit; **no workout-session SQL models yet**.
- Frontend: `frontend/src/store/useStore.js` persists personal profile JSON and local `S.active`. `frontend/src/views/Workout.jsx` is large. Relevant helpers: `frontend/src/lib/session-start.js`, `finish-workout.js`, `workout-model.js`, `history.js`, `progression.js`, `sync-merge.js`, `api.js` and `remote.js`.
- Deployment: `docker-compose.coolify.yml` already has `api` native MySQL `DATABASE_URL` via `SAAS_DATABASE_URL` and a manual `migrate` profile. Container gateway `host.docker.internal` is reachable from Coolify subnet `10.0.5.0/24` via UFW. **Do not reintroduce a MySQL Compose service or overwrite existing volumes.**
- Validation on live staging: migration/triggers, API health, PlatformAdmin role, Pilot Gym creation and accepted OWNER membership succeeded. A full two-user/two-tenant negative and restore drill is not yet confirmed; do not claim that it is.

## 2. Scope and non-goals

**Deliver this phase:** relational client-owned WorkoutSession, ClientActiveSession singleton slot, WorkoutSessionExercise, WorkoutSet, WorkoutOperation (idempotency ledger), WorkoutEvent (ordered events); a minimally sufficient participant representation only if required by authorization; session start/join/read/events, set creation/update/delete, minimal structural add/reorder/swap/remove, finish/cancel, clear concurrency/conflict behavior, JSON snapshot serialization, a small proof-of-concept client mode reusing existing UI/components, SQL concurrency integration tests, API contracts and deployment documentation.

**Defer to later phases:** WebSocket push and offline command queue (Phase 3), multi-client trainer console (Phase 4), full versioned routine assignments and complete combined history/progression/export (Phase 5), billing and seat limits (Phase 6). A lightweight REST polling/read-refresh flow is sufficient for Phase 2. If a routine version/assignment is not implemented yet, start a freestyle or validated snapshot workout, while designing nullable references for later phases. Do not fake or silently claim combined-history support.

## 3. Core invariants

1. A workout session belongs to exactly one client, with a durable SQL `clientUserId`, and optionally one explicitly chosen coaching organization. Clients can have multiple gym/trainer relationships, but at most **one ACTIVE SQL session per client** across organizations.
2. `ClientActiveSession(clientUserId PRIMARY KEY, sessionId UNIQUE FK)` guarantees the active slot. Allocate/release in the same transaction as start/complete/cancel. Concurrent starts must converge to one session. An unauthorized actor must not learn the details of somebody else's active session.
3. Legacy workouts stay in `S.active` and legacy completed workouts stay in profile JSON. Collaborative sessions are written **only** through SQL services and REST `/api/v2`; they must never be merged into or overwritten by `/api/data` or `sync-merge.js`.
4. Existing Phase 1 policy is binding for every read/write/replay, not merely at session start. Client self-access requires a valid active client identity. Trainer access requires active organization membership + enrolled client + accepted active relationship + unexpired matching client grant. No implicit owner/admin or PlatformAdmin access to client workouts.
5. Permission mapping: `VIEW_TRAINING` to read session/snapshot/events; `START_SESSION` to start/join when appropriately authorized; `LOG_SETS` to edit sets, structural operations and complete/cancel subject to explicit owner-only exceptions (document choices and tests). `MANAGE_ASSIGNMENTS` is reserved for Phase 5. Client may manage their own sessions; no user can impersonate a client by specifying actor IDs.
6. Verify organization/session/client consistency server-side. Never accept actor ID, tenant ID, user role or event sequence from client input as trusted authority. Do not leak another tenant's existence through error responses.
7. The database is the source of truth; events describe committed changes and are not merely notifications. Old offline requests are denied after revoke/expiry, including retries returning cached operation results; always authorize before returning idempotent responses.
8. Maintain existing set nuances: warmup versus working phase, drop/rest-pause, clusters, supersets, timed/cardio, per-side, assisted exercises, set notes, RIR/RPE fractions, kg/input units, `noProg`, deload, status. Do not silently flatten these into basic weight-and-reps.

## 4. Relational schema, Prisma migration and constraints

Extend `api/prisma/schema.prisma` additively with new migration(s). Follow the conceptual schema in the canonical spec; choose actual types, enum values and relations after checking Prisma 7/MySQL constraints:

- `WorkoutSession`: UUID PK, client identity FK, optional organization FK, nullable future assignment FK strategy (do not reference a table not yet created), startedByUserId FK, `status ACTIVE|COMPLETED|CANCELLED`, timestamps, structural `version`, monotonically increasing `lastEventSeq` (BIGINT or a safely encoded integral value), immutable/versioned routine prescription snapshot JSON, completion snapshot JSON or an explicit projection path, source and metadata fields, indexes for client/date and organization/status.
- `ClientActiveSession`: primary key clientUserId, unique FK sessionId; prevent orphaned, cross-client or stale slots. The application must atomically claim/release it. Consider database checks/transactional invariants beyond bare foreign keys.
- `WorkoutSessionExercise`: UUID PK, session FK, stable source exercise ID, optional routineSlotId, ordered position, snapshot of prescription/method, notes and `noProgression`, soft-delete marker, structural/version metadata.
- `WorkoutSet`: UUID PK, sessionExercise FK, optional plannedSetSlotId, order, work/warmup and method typed fields plus bounded schema-versioned JSON for complex variants; decimals in kg rather than float; `done`, `rir`, `reps`, notes, created/updated actor and times, integer per-set `version`, `deletedAt` tombstone. Unique `(sessionExerciseId, plannedSetSlotId)` for non-null prescribed slots; ad-hoc set IDs always independent. Validate set consistency and reject invalid JSON shapes.
- `WorkoutOperation`: unique `(sessionId, operationId)`, actor FK, canonical SHA-256 hash of normalized command including subject and values, result/response JSON, createdAt. A repeat with the same hash returns the same durable result; different hash -> `409 IDEMPOTENCY_KEY_REUSED` without mutation.
- `WorkoutEvent`: unique `(sessionId, sequence)`, event ID, operation ID and actor, type, validated bounded payload, server timestamp. Allocate each event sequence atomically by locking/updating its owning session inside the command transaction. Never use `MAX(sequence)+1` without locking; do not trust arrival order.

Schema protections: FKs/indexes, proper deletion restrictions, unique active slot, unique operation key, sensible indexed reads, all persisted session rows linked to authorized client/organization. No destructive changes to Phase 1 tables. Verify migration can run twice safely (`prisma migrate deploy`, twice) on disposable MySQL. Because existing MySQL uses binary logging, audit new triggers carefully; avoid global server-setting modifications in routine deploy scripts.

## 5. Transactional operation protocol

Use new `/api/v2/workout-sessions` services/routes, following the existing `saas/routes.js` modular handler style. Each operation uses one SQL transaction and checks policy against **current DB state**. Use bounded request schemas, decimal validations, sensible payload limits and explicit error codes; add OpenAPI contracts and test parity.

- **Start** `POST /api/v2/clients/:clientId/workout-sessions`: body `{organizationId, operationId, routineSnapshot?}`. Require valid UUID operationId (or documented stable client-generated ID). Check client self or `START_SESSION`; create exactly one active session and initial exercises/sets. If already active, return `200 {alreadyActive:true, session}` only if requester may view it; otherwise return a non-disclosing conflict/denial. Concurrent creates must be resolved in a transaction with DB constraint handling.
- **Read** `GET /api/v2/workout-sessions/:sessionId`: serialized authoritative snapshot including stable IDs, versions, status and `lastEventSeq`, scoped to session client. Read requires self or `VIEW_TRAINING`.
- **Replay** `GET /api/v2/workout-sessions/:sessionId/events?afterSequence=N`: durable ordered ascending event cursor with bounded page size and clear `hasMore`/`nextSequence`; same authorization as read. No websocket dependency yet.
- **Mutate** `POST /api/v2/workout-sessions/:sessionId/operations`: shared envelope `{operationId,type,target,expectedSetVersion?,expectedSessionVersion?,patch?}`. Types at minimum `set.create`, `set.update`, `set.delete` (tombstone), `exercise.add`, `exercise.swap`, `exercise.reorder`, `exercise.remove` and optional `session.update`. New rows may use server IDs or validated client-generated stable IDs; document exactly how idempotent retries recover IDs.
- **Set CAS:** use SQL compare-and-swap `UPDATE ... WHERE id=? AND version=? AND deletedAt IS NULL` and increment version. Different sets can edit concurrently; same-set stale version => `409 VERSION_CONFLICT` with sanitized latest record/current version and last committed session event sequence; never last-write-wins. A deleted set cannot be resurrected by a stale queued update.
- **Structural CAS:** exercise add/swap/reorder/remove and session notes require `expectedSessionVersion`; serialize against the session row, increment structural version and use soft delete. Structural changes may affect slots, but routine log changes to independent sets should not automatically conflict due to unrelated session structural version increments.
- **Complete/cancel:** `POST .../:sessionId/complete` and `.../cancel`, requiring `operationId` and `expectedSessionVersion` (document treatment of concurrent sets). Complete/cancel exactly once, atomically persist final snapshot/event, release active slot, reject post-completion mutation. Retried same operation returns original result. Build a normalized completed representation using existing `finish-workout.js` semantics; keep it in SQL or serve a projection without writing to legacy `S.workouts`.

**Atomicity for all operations:** authorize -> claim/check operation -> CAS/lifecycle update -> store replayable response -> append event -> commit. Handle duplicate-operation races and InnoDB deadlocks with bounded, correctly scoped retries. If an operation fails, do not emit an event or partial row. Always re-check authorization before replaying previously committed responses.

Example conflict:

```json
{
  "code": "VERSION_CONFLICT",
  "entity": "workoutSet",
  "entityId": "<uuid>",
  "expectedVersion": 2,
  "currentVersion": 3,
  "current": { "id": "<uuid>", "weightKg": "80.000", "reps": 10, "version": 3 },
  "latestSessionSequence": 7
}
```

**Safety boundary:** If trainer loses membership/grant mid-session, existing client session survives; trainer reads/writes immediately fail. Disabling/ending tenant relationship must not delete the client's workout history.

## 6. Phase 2 minimal UI / developer affordances

Provide a small, opt-in REST-based collaborative session mode under `COLLAB_WORKOUTS_ENABLED=0` by default. Reuse workout controls and relevant planning/presentation helpers where possible. Separate `collabSessions[sessionId]` or similar from legacy `S.active`. Display session ID/context, in-progress exercises and sets, and whether the current actor is client/trainer. Persist snapshots independently (not in `PUT /api/data` payload). No need for real-time WebSocket yet: manual refresh or low-frequency polling with event cursor is fine for the vertical-slice proof.

A 409 must surface both unsent local edit and current server row with `Keep server` / `Review and retry mine`; no silent overwrite. When access revoked, clear privileged cached trainer snapshot and disable mutations. Preserve offline personal workout operation; collaborative offline queue is Phase 3, so do not claim full offline support now.

Work out a usable test harness or small debug page if a complete UI refactor is impractical, but the Phase 2 definition of done still calls for a minimally accessible client UI mode—not just raw APIs.

## 7. Tests — all must be demonstrated, not assumed

Use real MySQL for concurrency and Prisma transactions; stub-only tests are insufficient. Build a **separate throwaway** `opengym_saas_test` database via an explicit `SAAS_TEST_DATABASE_URL`; never write/drop tables in the staging production `opengym_saas` DB. Preserve Phase 1 integration tests.

Required:

- Login and role isolation; PlatformAdmin does not gain client workout read; trainers have no access across organizations or without `VIEW_TRAINING`/`LOG_SETS`/`START_SESSION` grants; expired/revoked grant blocks immediately; client can retain history after leaving a gym.
- Two starts in parallel for the same client: one active slot, one canonical session, appropriate `alreadyActive` result; prevent unauthorized active-session disclosure.
- Two different sets updated concurrently: both changes persist. Same set with same expected version: exactly one succeeds, other gets detailed 409 and latest version.
- Duplicate `operationId` with same normalized body: identical durable result after restart, one database effect/event. Reused ID with different body: 409.
- Concurrent same planned slot creation: exactly one physical set. Tombstoned set + stale offline update: no resurrection.
- Complete vs update race and duplicate completion: one completion and no updates after finalized status; active slot released. Next session may start.
- Precise serial `WorkoutEvent.sequence` without gaps for committed operations; paged replay and snapshot correctness after process restart.
- Set-type parity round-trips: warmup, normal work, drop, rest-pause, timed/cardio, unilateral/per-side, decimals and assisted load, supersets, `noProg`, deload metadata, notes.
- With feature flag off, routes and UI are inert; personal OpenGym creation, `S.active`, legacy sync, exports and import remain unchanged. Check OpenAPI route parity and Docker/Coolify build.

Run and report actual output for the existing API tests (`cd api && npm test`), frontend tests/build (`cd frontend && npm test && npm run build`), Prisma generate/migration on test DB, `npm run test:mysql` against its guard-railed test DB, and relevant Docker smoke tests. Include newly written true-concurrent MySQL tests, not only sequential mocks. Report failures openly.

## 8. Deployment / rollback gate

1. Do not deploy while Phase 1 two-user negative authorization checks and coordinated SQL+JSON backup/restore rehearsal are outstanding, unless owner explicitly accepts residual risk on non-public staging.
2. Review additive migration and execute manually using the existing one-shot `migrate` image and correct Coolify network; do not enable automatic migrations on API startup.
3. Ensure `COLLAB_WORKOUTS_ENABLED=0` by default, and do not infer flag behavior from `SAAS_ENABLED`; both should be required to activate collaborative API.
4. Verify that a migration cannot break existing Phase 1 routes and legacy JSON accounts. Existing `main` deployment continues independently.
5. Functional rollback: disable `COLLAB_WORKOUTS_ENABLED`, redeploy. Keep SQL rows; don't drop completed-workout tables automatically. Data rollback/restoration requires coordinated SQL+JSON recovery and a tested procedure.
6. Backups must include MySQL tenant identity and session data **and** `/data` JSON; a single store alone is incomplete.

## 9. Deliverables and stop condition

Deliver at minimum:

- Additive migration(s) and schema design notes.
- New session service, typed/bounded validation, authorization adapter, v2 route integration and OpenAPI contract.
- Transactional operation and event-store tests (real MySQL), compatibility tests for current workout semantics.
- Minimal opt-in collaborative UI/prototype integrated without hijacking solo `S.active`.
- A new `docs/saas/02-phase-2-sessions.md` covering endpoints, flags, manual migration, testing, rollback, security and known gaps.
- End-of-task summary: commit/working tree status, exact files changed, commands run and results, feature-flag demonstration, outstanding risks, and *whether or not* it is safe to deploy.

**Stop after Phase 2.** Do not implement WebSockets, offline queue, multi-client dashboard, billing, full history/progression integration or automatic production migration as part of this assignment unless separately approved.

## Codex start prompt

> You are implementing ONLY OpenGym multi-tenant Phase 2 on branch `multitenant`. Read `CLAUDE.md`, `docs/multitenant/OPENGYM_MULTI_TENANT_CODEX_SPEC.md`, `docs/saas/00-audit.md`, this handoff, and inspect the live checked-out code. Implement transactional server-authoritative client-owned workout sessions in MySQL behind a default-off `COLLAB_WORKOUTS_ENABLED` flag, with one-active-session-per-client, scoped trainer permission enforcement, per-set optimistic locking, structural session locking, operation-id idempotency, immutable replayable event sequences, soft deletes, complete/cancel safety, a minimal reusable collaborative UI, OpenAPI, real-MySQL concurrency tests and backward compatibility with legacy JSON solo workouts. Never touch `main` or running production data; do not deploy. Stop after Phase 2 and report actual evidence and blockers.

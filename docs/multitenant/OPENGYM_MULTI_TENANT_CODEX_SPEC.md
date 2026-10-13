# OpenGym SaaS — Multi-Tenant Collaborative Training

**Codex implementation specification · v1.0 · 2026-10-12**  
**Target repository:** `https://github.com/vandr033/openGym`  
**Repository inspected:** `main` at `0210760a23982518e7990ab8c2a24372c13b94a9` (2026-10-12).  
**Status:** Design specification; no application code or production data has been modified.  
**Implementation style:** Phased, feature-flagged migration, one independently reviewable PR/phase at a time.

## 0. Instructions to Codex — read before writing code

1. First inspect the ACTUAL checked-out branch and uncommitted changes (`git status`, `git rev-parse HEAD`). **Do not overwrite user changes.** Read `CLAUDE.md`, `docs/chatgpt-handoff/*`, `api/server.js`, `frontend/src/store/useStore.js`, `frontend/src/views/Workout.jsx`, `frontend/src/lib/{session-start,finish-workout,progression,workout-model,history,sync-merge}.js`, `frontend/src/lib/api.js`, the login/pairing flows, Docker/Coolify configuration, and tests.
2. Treat `docs/chatgpt-handoff/*` as *dated documentation*, not current source. Its snapshot is `e8ef703`. As of inspected `main` (`0210760a`), later commits removed several HealthKit/server health files, including `frontend/ios/App/App/HealthKitPlugin.swift` and `api/health-data.js`. Confirm actual branch state and do **not** restore, remove, or silently rewrite the Apple Health feature as part of the SaaS work. Preserve existing features present in the local branch.
3. Phase 0 outputs an evidence-based architecture/diff audit and implementation task breakdown. For subsequent phases implement **only the approved current phase**, never the entire roadmap at once. A phase must compile/test, supply reversible database migrations when possible, and keep old flows working unless the acceptance criteria explicitly authorize a change.
4. Do not make a wholesale rewrite of the 150KB `api/server.js` or all of `useStore.js`. Add isolated modules/adapters and migrate incrementally. Do not replace working authentication or progression logic with new behavior without parity tests.
5. The owner confirms permission to modify and distribute the project. Keep any separate license notices for bundled exercise media/dependencies intact; licensing is not a blocker for this technical spec.

## 1. Product requirements and approved decisions

### Actors

- **Platform super-admin:** Creates/manages gym and independent-trainer organizations, subscriptions, plan limits and tenant operations. Platform staff do not automatically receive access to private workout/health records.
- **Gym owner/admin:** Invites trainers/staff; manages that gym's roster, only as permitted by client grants.
- **Trainer:** May be a member of multiple gyms **and** operate an independent training business from the same account; may have clients in multiple organizations.
- **Client:** Has one durable identity and personally owns workout history. May have multiple independent trainer/gym relationships concurrently.

### Training flows — non-negotiable

- Trainer creates/assigns routines and starts workouts *for a client* without impersonating that client.
- Trainer can have arbitrarily many independent client workouts active concurrently (design for at least 10 visible simultaneously).
- Trainer and client can view and **edit the same workout simultaneously**: log sets, adjust weight/reps/RIR/notes, add/swap exercises, change set status, and finish according to permissions.
- Both devices see acknowledged changes in near-real-time. Any client can refresh/reconnect and recover server state.
- Edits to different set records should succeed independently. Conflicting edits to the same set must return an explicit conflict and offer reconciliation. Never silently last-write-wins across collaborative edits.
- Each client has at most one server-backed **active** workout by default, independent of which trainer started it. If a second authorized trainer attempts to start one, return the existing session for joining (with a clear response), not a duplicate.
- Client retains their completed training history when they leave a gym. Organization/trainer access is revoked, but history is not deleted.
- Preserve personal/offline/guest workouts until migration is proven. Do not corrupt existing exported backups or the `opengym-routine-v1` import contract.

### Initial MVP

Tenant management; trainer/client invitations and permission grants; server-persisted collaborative sessions; simultaneous logging; multi-client trainer console; versioned routine assignments; combined workout history and progression; auditability and basic reports. Billing/white-label domains/appointment scheduling/group class bookings are deferred.

## 2. Verified current architecture and migration constraints

- `api/server.js`: Node 22 built-in `node:http`, signed cookie sessions, native phone bearer pairing, passkeys, optional passwords, instance-level admin features, JSON-file storage.
- `frontend/src/store/useStore.js`: Zustand persisted profile object; `S.active` belongs to one local device. Server data sync uses whole-document `PUT /api/data` with `baseRev`; 409 returns current state for client merge. `S.active` is kept locally during merge.
- `frontend/src/views/Workout.jsx`: existing workout UI includes many complex set types and session operations; it must not be rebuilt from scratch.
- `frontend/src/lib/session-start.js` and `finish-workout.js`: pure session start and completed-workout converters. **Preserve their contracts and test behavior.**
- `frontend/src/lib/progression.js`: history-derived progression including double, linear, Greyskull and timed. Warm-ups and excluded work must not contribute to inappropriate progression.
- `frontend/src/lib/sync-merge.js`: legacy whole-profile conflict merging (not suitable for concurrent authoritative set edits). Keep for legacy data until retired.
- `frontend/src/App.jsx`: HashRouter; React/Vite/Capacitor client. Existing login, native, imports, AI Coach, media and guest modes require backward compatibility.
- Current database is JSON files; no Prisma/SQL layer in inspected branch. Deployment has Docker and Coolify Compose configuration.
- Current repository HEAD differs from older handoff docs around Apple Health. Audit on local checkout, preserve any user branch changes and avoid adding new trainer health visibility by default.

**Key architectural boundary:** Collaborative `WorkoutSession` and `WorkoutSet` records MUST NOT be persisted via whole-profile `PUT /api/data` and must not be synchronized as `S.active`. New collaborative APIs/operations are the sole canonical writers of these records.

## 3. Target architecture (modular monolith)

```text
Existing React/Vite client + Capacitor
  ├── Legacy local workouts + profile JSON sync (temporarily unchanged)
  ├── Session data adapter (new): snapshots, commands, offline queue
  ├── Session store keyed by sessionId (new; NOT one global S.active)
  ├── Trainer multi-client console (new)
  └── Existing workout UI and pure workout/progression helpers (reused)
                      │ HTTPS + authenticated WebSocket
Existing Node HTTP process (keep auth/session compatibility)
  ├── Legacy routes /api/data, /api/auth, /api/coach ...
  └── Versioned /api/v2/ organizations, coaching, workout sessions
        ├── auth adapter: existing session -> authenticated user
        ├── tenant/client access policy service
        ├── routine/assignment service
        ├── workout command service + validation
        ├── read projections/history adapter
        └── websocket event dispatcher
                      │
            MySQL 8 + Prisma
               + session event ledger
               + SQL transactions
                      │
             Docker/Coolify volumes remain for legacy files/media
```

Use **MySQL 8 and Prisma** for new business data. Introduce TypeScript for *new modular code* if build tooling can be integrated safely; leave legacy JavaScript operational. Do **not** require a simultaneous switch from `node:http` to Express. Route v2 traffic through a small modular router/adapter integrated into the existing server; an Express migration, if desirable, is a separate later change. Build and deploy one API process initially; Redis is not needed until more than one application instance subscribes to live events. Durable database event replay is required even with one instance.

Feature flags: `SAAS_ENABLED=false`, `COLLAB_WORKOUTS_ENABLED=false` by default; enabling either must be explicit per environment. Do not implicitly turn off guest/local operation.

## 4. Ownership, tenancy and authorization

**Identity is global; membership is tenant-scoped; workouts are client-owned.**

- `User`: single identity; `legacyUid` unique mapping to existing session owner. Reuse existing passkey/password/mobile token auth initially; **do not duplicate passwords or credentials**.
- `PlatformRole`: super-admin explicitly provisioned through secure operator configuration. Do not auto-promote legacy `ADMIN_UIDS` into super-admin. Avoid platform admin implicit access to client history/Apple Health.
- `Organization`: type `GYM` or `TRAINER_BUSINESS`, settings, status, optional branding. A trainer business is not a separate backend/system.
- `OrganizationMembership`: `(organizationId, userId)` unique; role `OWNER|ADMIN|TRAINER|STAFF`, status `INVITED|ACTIVE|SUSPENDED`. Same user can belong to many organizations.
- `ClientOrganizationEnrollment`: clients may be enrolled in multiple gym/trainer organizations; enrollment alone does **not** imply all trainers may read their records.
- `TrainerClientRelationship`: `(organizationId, trainerUserId, clientUserId)` unique; `PENDING|ACTIVE|REVOKED`; invitation and acceptance metadata.
- `ClientAccessGrant`: explicit relationship-scoped permissions such as `VIEW_TRAINING`, `START_SESSION`, `LOG_SETS`, `MANAGE_ASSIGNMENTS`, `VIEW_BODYWEIGHT`; `VIEW_HEALTH` is **not granted by default** and is outside initial MVP. Expiry/revocation must take effect immediately at new reads, writes and socket subscriptions.

Tenant context must be chosen/validated server-side for each coaching action; never trust a bare organization ID in a request without checking active membership AND client relationship AND effective grant. Organization branding/custom domain should not determine authorization. Client's own workouts may have `coachingOrganizationId = null` (private solo workout). If initiated by trainer, save the explicit organization context and acting user.

Authorization matrix:

| Action | Client | Authorized relationship trainer | Org admin | Platform admin |
|---|---|---|---|---|
| View own session | Yes | N/A | N/A | N/A |
| View client's session | N/A | With `VIEW_TRAINING` | Only explicit grant/policy | No automatic access |
| Start on behalf of client | Own | With `START_SESSION` | With explicit scope | No automatic access |
| Log/edit sets | Own | With `LOG_SETS` | Only explicit grant | No automatic access |
| Assign program | Own local plan | With `MANAGE_ASSIGNMENTS` | Scoped by explicit policy | No automatic access |
| Manage organization | N/A | If OWNER/ADMIN | Own organization | Platform-only administrative actions |

Explicit client consent and an auditable invite/accept/revoke workflow are required. An organization membership and a client access grant are **both** needed for trainer action.

## 5. Proposed relational schema (conceptual Prisma migration target)

Implement these core models and indexes, choosing IDs consistent with existing code (UUID/CUID acceptable, stable across offline retries). Use DB-enforced uniqueness, foreign keys and transactions; do not rely on UI validation.

### SaaS and coaching

```text
User(id PK, legacyUid UNIQUE NULLABLE, displayName, status, createdAt)
PlatformAdmin(userId PK FK, grantedBy, grantedAt)
Organization(id PK, type, name, slug UNIQUE, status, settingsJson, createdAt)
OrganizationMembership(id PK, organizationId FK, userId FK, role, status,
                       UNIQUE(organizationId,userId), INDEX(userId,status))
ClientOrganizationEnrollment(id PK, organizationId FK, clientUserId FK, status,
                             UNIQUE(organizationId,clientUserId))
TrainerClientRelationship(id PK, organizationId FK, trainerUserId FK, clientUserId FK,
                          status, acceptedAt, revokedAt,
                          UNIQUE(organizationId,trainerUserId,clientUserId))
ClientAccessGrant(id PK, relationshipId FK, scope, grantedAt, expiresAt, revokedAt,
                  UNIQUE(relationshipId,scope))
RoutineTemplate(id PK, ownerUserId FK NULL, organizationId FK NULL,
                visibility, title, status, createdAt)
RoutineVersion(id PK, routineTemplateId FK, version INT, schemaVersion, payloadJson,
               createdByUserId FK, createdAt, UNIQUE(routineTemplateId,version))
RoutineAssignment(id PK, clientUserId FK, trainerUserId FK, organizationId FK,
                  routineVersionId FK, scheduleJson, startAt, endAt, status,
                  assignedAt, revokedAt)
```

`RoutineVersion.payloadJson` contains a validated, immutable snapshot of exercise prescription and is compatible with the existing routine import format via an explicit adapter. Preserve a routine's version history even if the trainer edits their template. Never change a live assignment's historical prescription in place; assign or activate a new version.

### Collaborative workouts

```text
WorkoutSession(id PK, clientUserId FK, coachingOrganizationId FK NULL,
               routineAssignmentId FK NULL, startedByUserId FK,
               status ACTIVE|COMPLETED|CANCELLED,
               startedAt, completedAt NULL, cancelledAt NULL,
               version INT, lastEventSeq BIGINT, source,
               routineSnapshotJson, metadataJson, createdAt, updatedAt,
               INDEX(clientUserId,startedAt), INDEX(coachingOrganizationId,status))
ClientActiveSession(clientUserId PK FK, workoutSessionId UNIQUE FK)
WorkoutSessionParticipant(id PK, sessionId FK, userId FK, role,
                          UNIQUE(sessionId,userId))
WorkoutSessionExercise(id PK, sessionId FK, exerciseId, routineSlotId NULL,
                       sortOrder, prescriptionJson, notes, noProgression,
                       deletedAt NULL, version INT,
                       INDEX(sessionId,sortOrder))
WorkoutSet(id PK, sessionExerciseId FK, plannedSetSlotId NULL,
           sortOrder, kind, done, weightKg DECIMAL(10,3) NULL, reps NULL,
           rir NULL, seconds NULL, sidesJson NULL, extraJson NULL,
           notes NULL, version INT, createdByUserId FK, updatedByUserId FK,
           deletedAt NULL, createdAt, updatedAt,
           UNIQUE(sessionExerciseId,plannedSetSlotId),
           INDEX(sessionExerciseId,sortOrder))
WorkoutOperation(id PK, sessionId FK, operationId, actorUserId FK,
                 opType, requestHash, responseJson, createdAt,
                 UNIQUE(sessionId,operationId))
WorkoutEvent(id PK, sessionId FK, sequence BIGINT, operationId,
             actorUserId FK, eventType, payloadJson, createdAt,
             UNIQUE(sessionId,sequence), INDEX(sessionId,createdAt))
LegacyWorkoutMapping(id PK, clientUserId FK, legacyWorkoutId, sqlSessionId UNIQUE,
                     UNIQUE(clientUserId,legacyWorkoutId))
```

**Schema caveat:** MySQL permits multiple NULLs in a unique index. Planned set slots must be non-null for prescribed sets, with a unique constraint; free/ad-hoc sets have NULL `plannedSetSlotId` and distinct `id`. `ClientActiveSession` enforces exactly one active-session slot per client by inserting/deleting the row in the same transaction as lifecycle transitions. Handle start races by returning the already-active session; never run check-then-insert outside a transaction.

Do not force all future workout variants into `weightKg`+`reps`: timed/cardio, per-side, assisted, warmup/drop/rest-pause and existing metadata need validated typed extensions (`sidesJson`, `extraJson`, `prescriptionJson`) and roundtrip parity tests. Store canonical load in kilograms with the client's entered-unit context retained where needed, use Decimal not floating-point DB columns, and avoid implicit unit drift. `WorkoutEvent` is an ordered replay/audit ledger; it does not replace current materialized workout tables. Record all mutations by actor.

## 6. Workout state machine, ownership and simultaneous editing

### Lifecycle

`ACTIVE -> COMPLETED` or `ACTIVE -> CANCELLED`; unauthorized reopening is disallowed in MVP. Completed-session corrections should be separate audited operations, not silent unversioned mutations. Preserve original `startedAt`, completion time, client identity and organization context.

`start(clientId, organizationId, assignmentId?)`:
1. Authenticate actor, derive identity from existing cookie/bearer token.
2. Authorize `START_SESSION` in the explicit organization/relationship context (or self).
3. In SQL transaction, claim `ClientActiveSession(clientId)` unique slot. If already claimed by another ACTIVE session, return HTTP 200 with `{ alreadyActive: true, session }`; if the row is stale, repair via validated controlled transaction.
4. Resolve routine version and build a **server-owned immutable session-start prescription snapshot** based on the client's authorized plan/history. Reuse/refactor existing pure `session-start.js` and progression helpers, with cross-runtime parity tests if moved to shared code. For freestyle sessions, validate submitted exercises.
5. Create ordered exercise and planned-set rows with stable IDs; commit before notifying participants.

### Mutations

Persist session commands as **SQL transactions**; do not use `PUT /api/data` or full-JSON overwrites:

- `set.create`: stable `operationId`, `setId`, `sessionExerciseId`, optional `plannedSetSlotId`; reject duplicate planned slot with 409 and current record.
- `set.update`: `expectedSetVersion` required. Perform compare-and-swap (`UPDATE ... WHERE id=? AND version=? AND deletedAt IS NULL`), increment version, and audit actor.
- `set.delete`: soft-delete/tombstone with expected version, so disconnected devices cannot resurrect it.
- `exercise.add`, `exercise.swap`, `exercise.reorder`, `exercise.remove`: require `expectedSessionVersion` and validate program/exercise compatibility.
- `session.update` (notes/metadata) requires version checks. `session.complete` must verify latest session version, exercise rows and actor permission; finalize completed workout once only.

Independent sets do **not** require whole-session optimistic locking, otherwise a trainer logging Client A's set 2 and a client logging set 4 would conflict needlessly. Structural changes must serialize at session level. For a single set, use conservative per-row optimistic concurrency even if edited fields differ; UX should present the conflicting values and allow explicit retry.

### Exactly-once effects from retried commands

Every mutation carries a UUID `operationId` generated by the client and persisted before the network request. `WorkoutOperation(sessionId, operationId)` is unique. On retry with an identical request hash return the original response without replaying side effects. If an `operationId` is reused with different payload return 409 `IDEMPOTENCY_KEY_REUSED`.

Atomic commit: mutation + version increments + persisted `WorkoutOperation` + append `WorkoutEvent` with monotonic per-session `sequence`. The server publishes the event after the DB commits. If broadcasting fails, subscribers recover using the database event cursor.

### Conflicts

`409` response shape:

```json
{
  "code": "VERSION_CONFLICT",
  "entity": "workoutSet",
  "entityId": "set_123",
  "expectedVersion": 4,
  "currentVersion": 5,
  "current": { "id": "set_123", "weightKg": "80.000", "reps": 10, "version": 5 },
  "latestSessionSequence": 73
}
```

Client conflict UI must show *my unsaved change* vs *latest server record (and who/when)* and offer `Keep server version`, `Apply mine after review` (new versioned request), and where safe `Cancel`. NEVER silently overwrite. If authorization was revoked, do not allow force-apply. For a proposed prescribed-set duplicate, offer to use existing set or add an explicitly new ad-hoc set. Preserve unacknowledged user input while resolving.

### Completion and progression

On complete, generate the exact normalized completed-workout representation using `buildCompletedWorkout`-compatible pure logic. History and progression read from canonical data: legacy completed sessions (transition period) + SQL completed sessions (deduplicated) ordered chronologically. Warmup/straight work, RIR, per-side, time, cardio, noProg, deload, supersets, plans vs actuals must preserve current behavior. Compute progression from **actual completed history**, not a separate mutable counter. Completion must be idempotent and auditable.

## 7. HTTP API contract — new `/api/v2` routes

Keep existing `/api/data`, auth, Coach, media and admin endpoints unchanged until a separate migration phase. Follow existing cookie/bearer security and error conventions.

```http
POST   /api/v2/platform/organizations
GET    /api/v2/platform/organizations
GET    /api/v2/organizations/me
POST   /api/v2/organizations/:orgId/members/invitations
GET    /api/v2/organizations/:orgId/trainers
GET    /api/v2/organizations/:orgId/clients
POST   /api/v2/organizations/:orgId/clients/invitations
POST   /api/v2/coaching/relationships/:id/accept
POST   /api/v2/coaching/relationships/:id/revoke
PUT    /api/v2/coaching/relationships/:id/grants
GET    /api/v2/trainers/me/active-workouts?organizationId=...
POST   /api/v2/routine-templates
POST   /api/v2/routine-templates/:id/versions
POST   /api/v2/routine-assignments
GET    /api/v2/clients/:clientId/routine-assignments
POST   /api/v2/clients/:clientId/workout-sessions
GET    /api/v2/workout-sessions/:sessionId
GET    /api/v2/workout-sessions/:sessionId/events?afterSequence=...
POST   /api/v2/workout-sessions/:sessionId/operations
POST   /api/v2/workout-sessions/:sessionId/complete
POST   /api/v2/workout-sessions/:sessionId/cancel
GET    /api/v2/clients/:clientId/workout-history
GET    /api/v2/clients/:clientId/progress
GET    /api/v2/me/workout-history
```

### Example: start a coached workout

```http
POST /api/v2/clients/client_42/workout-sessions
Content-Type: application/json

{
  "organizationId": "org_7",
  "routineAssignmentId": "assignment_10",
  "operationId": "1ebd9e3b-844b-44c9-ad83-0211b47a3e38"
}
```

**Response:** `201` `{ "alreadyActive": false, "session": { "id": "s_42", "clientUserId": "client_42", "status": "ACTIVE", "version": 1, "lastEventSeq": 1 } }`. If active session exists, return `200` `{ "alreadyActive": true, "session": ... }`. Validate the already-active session is visible to this actor before returning any data; otherwise return a permission/conflict response without leaking a client's workout.

### Example: simultaneous set logging

```http
POST /api/v2/workout-sessions/s_42/operations
Content-Type: application/json

{
  "operationId": "56452422-77d0-4743-93d2-7f2db0160ad0",
  "type": "set.update",
  "expectedSetVersion": 2,
  "target": { "setId": "set_5" },
  "patch": { "weightKg": "80.000", "reps": 10, "done": true }
}
```

**Success** `200` `{ "accepted": true, "sessionId": "s_42", "eventSequence": 74, "record": { "id": "set_5", "version": 3, ... } }`. **Conflict** `409` as above. **Revoked grant** `403`. **Completed session** `409 SESSION_NOT_ACTIVE`. Unsupported mutation or invalid set details `422` with field-level errors. Enforce bounded payload sizes and rate limits.

Document the APIs in `api/openapi.yaml` and provide typed client functions, validation schemas and contract tests. No caller may supply `createdByUserId`, `actorUserId`, `clientUserId` overrides or authority flags to bypass policy; derive actor from authenticated session and client from the authorized session record.

## 8. Real-time protocol

Use authenticated **WebSocket** endpoint `/api/v2/realtime`, integrated with the existing Node process. Browser cookie authentication requires strict Origin checking; native bearer credential must be sent via a supported protected handshake/auth mechanism, never a URL query parameter or console log. Reuse the existing signed session/phone token verification and session revocation semantics.

Protocol envelope:

```json
{
  "type": "workout.event",
  "sessionId": "s_42",
  "sequence": 74,
  "eventId": "evt_74",
  "actorUserId": "trainer_1",
  "eventType": "set.updated",
  "payload": { "setId": "set_5", "version": 3, "reps": 10, "weightKg": "80.000" }
}
```

- Authenticated `subscribe` command accepts `{sessionId, afterSequence}`. Authorize each subscription. Trainer console may subscribe to 10+ sessions over **one** socket.
- On subscribe/reconnect, client first fetches a snapshot, then requests ordered `WorkoutEvent` replay after its cursor; avoid gaps between snapshot and stream by including snapshot's `lastEventSeq`, buffering or replaying events newer than that cursor. Deduplicate events by `(sessionId, sequence)`.
- The DB is authoritative: WebSockets are notification/replay transport, never the source of truth or a substitute for committed transactions.
- Deliver actor-aware events to both client and authorized trainers; a trainer sees immediate changes from clients without page refresh. Presence / local rest timers are ephemeral and must not affect set persistence.
- Revoked grants/suspended organization/revoked login sessions remove subscriptions immediately and reject new reads/operations; force clients to discard sensitive cached roster data when access is revoked.
- On restart clients reconnect, reauthenticate, reload snapshots and replay missed events. Persist event cursors; support event retention/compaction only after defining snapshot recovery guarantees.
- First release is single API instance; Redis adapter or message bus is a later scaling task, not a prerequisite.

## 9. Frontend and UX

### Maintain existing workout UI

Create a *session data source adapter* so `Workout.jsx` and pure utilities can run with either `(a) local legacy S.active` or `(b) server-backed WorkoutSession snapshot + operations`. Preserve UI behavior for per-side sets, timers, timed/cardio, assisted movement, notes, warmups, set types, deload and PR visuals. Avoid copying 97KB of JSX into a separate trainer workout app.

Create a lightweight `collaborativeSessionStore` keyed by `sessionId`; each entry tracks snapshot, event cursor, pending operations, connectivity and conflict state. **Do not reuse global `S.active` for ten simultaneous clients**. Single-client screen chooses an active `sessionId` and derives its view. Trainer switching clients does not change authentication context or interrupt other sessions.

### Trainer multi-client console

Routes could be `/#/trainer/clients`, `/#/trainer/live`, `/#/trainer/client/:id`, `/#/trainer/session/:sessionId` (respect actual HashRouter conventions). Dashboard shows multiple active cards with client name, routine, last logged set, currently focused exercise, completion count, connection status and quick actions. Trainer can start/resume any authorized client session, expand a specific session, log sets, view history/progression and return to another client without losing edits. A notification/presence change is distinct from successful persistence.

Client workout screen displays who started it and authorized editors; show small attribution for trainer/client changes. Provide clear `Saved`, `Syncing`, `Offline queued`, and `Conflict` states; never falsely show Saved for an optimistic, not-yet-acknowledged operation.

### Offline policy

- Preserve **existing local-only solo training** flow and local backup behavior.
- Collaborative session can queue writes offline *only after its server session ID and snapshot have been obtained*. Use durable IndexedDB (or native file-backed queue if required for Capacitor) with UUID operation IDs and order, not volatile React state.
- On reconnect: reauthenticate, verify permission/status, load latest snapshot/replay, upload queued commands serially where dependent, reconcile version conflicts visibly. Do not replay writes from a stale revoked trainer grant. Keep unsent input available for review/export rather than losing it.
- Starting brand-new trainer-owned collaborative sessions while offline is **not MVP**. Display a clear unavailable message and offer an explicitly separate solo/local mode if appropriate; never create two apparently canonical sessions that diverge.

### Workout history coexistence

Do **not** dual-write collaborative sessions blindly into `state-<uid>.json`: legacy whole-document pushes may subsequently erase, duplicate or resurrect records. During transition use a *read-only combined-history adapter* joining legacy local/profile completed workouts with canonical SQL completed sessions. Stable `legacyWorkoutId`/`sqlSessionId` mapping and deduplication prevent duplicate PRs, progression results and exports. If local changes to legacy history later need SQL import, implement an idempotent importer with dry-run/reconciliation and full parity tests.

## 10. Security, privacy and audit requirements

1. Deny by default. Every GET, REST mutation and WebSocket subscription must check authenticated identity, organization membership, client-specific relationship/grants and relevant session status. Re-evaluate on every command (not only socket connection).
2. Restrict list queries by actual authorized roster; predictable IDs must not expose client names, workout metadata or private notes across organizations. Cover IDOR/cross-tenant test cases.
3. Avoid putting bearer tokens in URLs; protect browser sessions with correct Origin/CSRF defenses and native tokens with supported headers/subprotocol authentication. Keep WebAuthn RP_ID/ORIGIN compatibility; custom tenant domains are out of scope.
4. Clients retain their workout history on relationship termination. Revocation stops new trainer reads/writes; do not retroactively delete client-owned sessions. Define export/deletion operations and privacy policy separately.
5. Treat Apple Health / sleep / recovery as **private, separate opt-in data**; trainer access is not part of initial MVP. Do not copy personal health payloads into organization tables. Audit current branch state before touching health integration.
6. Audit session start, assignment, every set write/delete, completion, trainer invitation, grant/revoke and administrative change. Capture actor, client, organization, request operation ID and timestamp without leaking auth tokens or unnecessary sensitive detail into generic logs.
7. Session notes/media references may contain user data. Validate and sanitize; enforce owner/client permissions consistently with media routes. Prevent access to other users' uploads even when referencing a workout.
8. Add service-level rate limits, bounded payloads, sensible socket subscription limits, pagination, backup encryption/access controls and monitoring. Preserve existing secret/data volumes during deploys.

## 11. Migration and deployment plan

- Always snapshot/backup: `db.json`, all `state-<uid>.json` files, `secret`, uploads, Coach configuration, and any existing native/health data that still exists on the actual branch. Test restore before production migration. Once SQL exists, backups must include MySQL consistently with filesystem data.
- Add MySQL service/database with distinct credentials; Prisma migrations must be checked in and work under Coolify Docker compose. Avoid publicly exposing MySQL port. Deploy feature flags disabled initially.
- Map legacy users to `User` using stable `legacyUid` through a repeatable, idempotent migration/on-login adapter. Keep existing authentication working, including signed cookies and native pairing. New session login must not create duplicate identities.
- Establish organization/permission APIs first; migrate *new* collaborative sessions to SQL; legacy solo workout flows remain on JSON until proven safe. Do not delete JSON on migration.
- Add combined history/progression and export adapters **before** production rollout of completed collaborative workouts. Rollout must not break existing statistics even if collaborative sessions finish from the trainer device while the client's phone is offline.
- Backfill historical workouts as a separate dry-run capable tool, with counts/hashes, deterministic IDs, deduplication, rollback instructions and tests. Avoid writing back into old sync files from the SQL migration.
- Production feature flag rollout: platform admin pilot -> one independent trainer + consenting client -> one gym + multiple trainers -> multi-client real-time sessions -> broader tenant rollout. Monitor conflicts, event replay gaps, API errors, duplicate-set rejection and database health.
- Rollback: disabling collaboration must keep canonical SQL records intact and still readable/exportable with operator tooling. Schema migrations should be backward compatible; destructive cleanup is a later explicitly approved release.

## 12. Implementation phases, handoff artifacts and definition of done

### Phase 0 — repo/branch audit and architectural plan (first Codex task)

Deliver `docs/saas/00-audit.md`: checked-out commit and dirty files; current state/auth/routes schema; exact workout fields and special set types; mobile/offline behavior; HealthKit discrepancy; where legacy completed history is consumed; deployment and test scripts; gap/risk matrix; proposed changed file paths. List TODOs with exact source references. **No feature changes.**

**Pass:** Evidence comes from actual local code, no unverified assumptions, list of regression tests and signed-off phase plan.

### Phase 1 — SQL, identity, organizations, access

Deliver Prisma schema/migrations, MySQL docker integration, legacy UID adapter, platform admin provisioning, gym/trainer business CRUD, membership/invite acceptance, trainer-client relationship and explicit access grants, audited authorization helpers, OpenAPI contracts, and integration tests. Keep `SAAS_ENABLED` off by default.

**Pass:** User works at two gyms + own independent organization without identity duplication; client can accept two concurrent trainer relationships; cross-tenant privilege escalation tests fail with 403/404; existing login and local workouts remain functional.

### Phase 2 — server-authoritative sessions (vertical slice)

Deliver session schema, active slot uniqueness, start/resume/read, prescribed set IDs, typed operation dispatcher, transactional CAS, idempotency, tombstone events, finish-to-completed-workout adapter, an initial one-client collaborative UI mode behind flag, and compatibility tests.

**Pass:** Trainer A can start Client X's workout; both independently log/update different sets; same-set concurrent edit yields 409 with current record; duplicate operationId has one effect; second start joins existing; completion occurs once.

### Phase 3 — WebSocket + offline reconciliation

Deliver authenticated subscriptions, ordered replay, reconnect recovery, revocation handling, durable queue, optimistic/conflict UI and one-session end-to-end tests with browser/native considerations.

**Pass:** Two devices update in near real time, no lost/duplicate sets after reconnect and process restart; revoked trainer cannot subscribe/write; outstanding local edits remain recoverable for review.

### Phase 4 — multi-client trainer experience

Deliver multi-client active session dashboard, trainer quick logging, 10+ session subscriptions over one socket, stable session stores per client, ability to move between clients while another device edits, and scoped progress views.

**Pass:** Trainer can concurrently manage at least 10 client sessions and switch without cross-client data bleed. Different client sessions are fully isolated; disconnect and refresh recover state.

### Phase 5 — routines, migration and progress parity

Deliver immutable versioned routine templates/assignments, schedule activation, legacy routine import compatibility, combined-history adapter, existing stats/export integration, migration dry run, parity tests for all progression/set types, and client opt-in or notification workflows.

**Pass:** Trainer assigns routine version to client; client sees it; future changes don't rewrite historical sessions; `double` progression advances only when every eligible work set hits the top and resets reps after load increase; warmups/rest-pause/drop/deload exclusions remain correct; SQL+legacy history does not double count.

### Phase 6 — SaaS operations and hardening

Deliver subscriptions/seat limits, audit/admin tooling, tenant lifecycle, backup/restore drill, load testing, observability, regression suites, documentation, security review and deployment checklist. Billing provider integration is separately scoped.

**Pass:** Operator can administer gyms/trainers without routine access to private client health/workout data; production staging pass and tested restoration.

## 13. Required automated tests (minimum matrix)

**Authorization:** Gym A cannot enumerate Gym B roster/routines/sessions; independent trainer belongs to multiple orgs; client has multiple relationships; trainer loses access on revoke/expiry; non-enrolled user blocked; platform admin has no implicit client-data reads; existing native token/session revocation respected.

**Concurrency:** client+trainer insert *different* sets simultaneously (both committed); update *same* set from two stale versions (one committed, one explicit 409); same planned slot created concurrently (one row only); duplicate `operationId` replay (one effect); same operationId different payload (409); delete vs offline stale edit (no resurrection); two starts for one client (one canonical active session); finish vs late set (no post-completion edits); two clients on one trainer dashboard (independent state).

**Sync/reconnect:** network drop before/after commit, duplicate WebSocket delivery, missed-event replay, server restart, stale queue after revoke, client device offline while trainer finishes, multiple browser tabs, session cursor gap, browser cookie and mobile bearer auth.

**Workout regression:** straight sets, warmups, drop/rest-pause, timed/cardio, per-side, assistance machine, supersets, `noProg`, deload, unit conversion, history edits, backfill, PRs and double-progression rep/load reset, exports, import and legacy `S.active` solo behavior.

**Operational:** SQL migration applied twice safely, legacy UID mapping idempotent, backups/restores include SQL + files, feature flags off regressions, Docker/Coolify build, frontend/API/MCP tests and mobile build when native files are touched.

Run existing commands according to repo:

```bash
cd frontend && npm test && npm run build
cd api && npm test
cd mcp && npm test
# Also new Prisma migration/integration suites and app/container smoke tests.
```

Do not claim tests pass unless run. Add integration database CI fixture/environment for transactional tests. Simulate races with true parallel transactions, not a sequential fake/mock.

## 14. PR format and engineering quality bar

Each PR must include:

1. Goal, scope, exact files changed, why integration points were chosen.
2. Schema/migrations and backwards compatibility/rollback impact.
3. Permission/security review, cross-tenant test evidence.
4. Tests run and actual pass/fail results, including known gaps.
5. New/modified API contracts and frontend UX screenshots when relevant.
6. Risks, deployment flags, next phase dependencies, explicit items intentionally not built.

Prioritize behavior parity over refactor aesthetics; never weaken authentication, remove mobile pairing, break local mode, collapse special set types, rewrite existing history, or silently make legacy admin a platform super-admin. Never ship unfinished code as enabled-by-default SaaS.

## 15. First concrete vertical slice acceptance scenario

1. Platform operator creates Gym One and Independent Trainer Biz.
2. Same Trainer T belongs to both organizations.
3. Clients A and B accept separate trainer grants; Client A also accepts an unrelated second trainer.
4. Trainer T selects Gym One and starts Workout A; selects Independent Biz and starts Workout B. Both remain active, with one identity and two separate live states.
5. Client A opens Workout A on their phone. Trainer T logs `Bench Press 80 kg × 10` from dashboard; Client A sees it after commit. Client A logs a different set; trainer sees it. Both records persist after refresh.
6. Client A and Trainer T concurrently edit the **same** set based on version 2. One update succeeds; one gets a visible conflict and can explicitly reconcile. There is no silent override.
7. Trainer T completes Workout B while A remains active. Workout B appears once in B's history and affects B's progression only; A remains unchanged.
8. Trainer T's organization grant for A is revoked mid-session; subsequent new reads, writes and socket subscriptions fail. Client A retains the session and history.
9. Legacy personal workouts and new collaborative completed workouts appear once each in history/export, including after server restart, and correctly drive existing progression.
10. Regression suite, SQL tests and Docker smoke checks pass and are reported with outputs.

**Stop and report any unavoidable blocker before replacing legacy behavior.**

---

### Primary repo evidence, checked on 2026-10-12

- [Repository `main`](https://github.com/vandr033/openGym/tree/main)
- [`api/server.js`](https://github.com/vandr033/openGym/blob/main/api/server.js)
- [`frontend/src/store/useStore.js`](https://github.com/vandr033/openGym/blob/main/frontend/src/store/useStore.js)
- [`frontend/src/views/Workout.jsx`](https://github.com/vandr033/openGym/blob/main/frontend/src/views/Workout.jsx)
- [`frontend/src/lib/session-start.js`](https://github.com/vandr033/openGym/blob/main/frontend/src/lib/session-start.js)
- [`frontend/src/lib/finish-workout.js`](https://github.com/vandr033/openGym/blob/main/frontend/src/lib/finish-workout.js)
- [`frontend/src/lib/progression.js`](https://github.com/vandr033/openGym/blob/main/frontend/src/lib/progression.js)
- [`frontend/src/lib/sync-merge.js`](https://github.com/vandr033/openGym/blob/main/frontend/src/lib/sync-merge.js)
- [`docs/chatgpt-handoff/PROJECT_CONTEXT.md`](https://github.com/vandr033/openGym/blob/main/docs/chatgpt-handoff/PROJECT_CONTEXT.md) — older snapshot
- [`docs/chatgpt-handoff/TECHNICAL_REFERENCE.md`](https://github.com/vandr033/openGym/blob/main/docs/chatgpt-handoff/TECHNICAL_REFERENCE.md) — older snapshot
- [Diff of old handoff snapshot to inspected HEAD](https://github.com/vandr033/openGym/compare/e8ef703...main)

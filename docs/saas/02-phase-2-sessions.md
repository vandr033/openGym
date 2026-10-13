# Phase 2: collaborative workout sessions

Phase 2 adds client-owned workout sessions to the existing SaaS MySQL schema. It is opt-in and separate from the solo workout in `S.active`, profile JSON, `/api/data`, and legacy history. It does not add live push, an offline command queue, trainer dashboard, or combined history/progression.

## Enablement

Both flags must be enabled for the API. The default is off in both Compose files:

```dotenv
SAAS_ENABLED=0
COLLAB_WORKOUTS_ENABLED=0
```

The web client receives `collab_workouts: true` from `/api/config` only when both flags are on. Until then, the route and home entry are absent in the UI, and collaborative API routes return `404` before opening the database. Changing `COLLAB_WORKOUTS_ENABLED` alone cannot activate the feature.

## Data model and consistency

The additive migration `api/prisma/migrations/20261013010000_workout_sessions` creates:

- `WorkoutSession` with its client, optional organization, state, structural version, event cursor, routine snapshot, and SQL completion projection.
- `ClientActiveSession`, keyed by client, with composite ownership and unique session constraints. Session start and finish/cancel claim or release it in the same transaction.
- `WorkoutSessionExercise` and `WorkoutSet`, with session-scoped exercise snapshots, decimal kilogram values, warm-up/work phase, effort and complex variant data, versions, and soft-delete timestamps.
- Append-only `WorkoutOperation` idempotency results and `WorkoutEvent` sequence records. Database triggers reject updates or deletes to either ledger.

Every write checks the actor against current identity and consent rows. A client acts only as themselves. A trainer must have an active membership, enrollment, relationship, and the exact current permission grant. `VIEW_TRAINING`, `START_SESSION`, and `LOG_SETS` are independent. Organization owners, admins, and PlatformAdmins get no implicit workout access. A failed scope check returns the same `404` as an unknown session.

Set updates and deletes require `expectedSetVersion`; a stale request returns `409 VERSION_CONFLICT` with the latest set and event cursor. Exercise structure and session notes require `expectedSessionVersion`. Every successful operation, response ledger entry, and event commit atomically. A repeated operation ID with the same normalized request returns the stored response; reusing it for another request returns `409 IDEMPOTENCY_KEY_REUSED`. Deleted rows remain tombstoned and cannot be restored by stale writes. Deadlocks and lock timeouts retry at most twice inside the service.

Set `details` is schema version 1. Its `data` values preserve rep/time/cardio modes, drops, clusters, unilateral left/right values, assisted load, notes, and effort values. The routine snapshot retains deload/program/readiness and exercise prescription/superset/progression metadata. Completed work is projected into SQL using the same inclusion rule as `buildCompletedWorkout`: keep exercises with completed work, including a completed side of a unilateral set, and preserve their logged sets. It is not translated into the legacy profile-history schema in this phase.

## REST surface

All routes require both flags, a signed-in active account, and JSON requests.

| Route | Behavior |
| --- | --- |
| `GET /api/v2/clients/:clientId/workout-sessions/active` | Client-only lookup of the client's active SQL session. |
| `POST /api/v2/clients/:clientId/workout-sessions` | Start a freestyle or snapshot session; a trainer needs `START_SESSION`. Returns `201` for a new session or `200` for an authorized existing session. |
| `GET /api/v2/workout-sessions/:sessionId` | Read an authoritative snapshot; client self or `VIEW_TRAINING`. |
| `GET /api/v2/workout-sessions/:sessionId/events?afterSequence=0&limit=100` | Read committed events in ascending sequence order; cursor is a decimal string and page size is 1–100. |
| `POST /api/v2/workout-sessions/:sessionId/operations` | Apply one idempotent operation. Types: `set.create`, `set.update`, `set.delete`, `exercise.add`, `exercise.swap`, `exercise.reorder`, `exercise.remove`, `session.update`. Client self or `LOG_SETS`. |
| `POST /api/v2/workout-sessions/:sessionId/complete` | Save the completion projection and release the active slot. |
| `POST /api/v2/workout-sessions/:sessionId/cancel` | Cancel the session and release the active slot. |

Start takes `{operationId, organizationId?, routineSnapshot?}`. Operation IDs are client-generated UUIDs. Server-generated exercise and set IDs are returned in the committed result and persisted for replay. A trainer with `START_SESSION` but without `VIEW_TRAINING` receives session metadata only; they cannot join an existing session or read its details. Set operations target a session-exercise UUID for create or a set UUID for update/delete; the corresponding expected version is required. Lifecycle requests require `{operationId, expectedSessionVersion}`. The OpenAPI contract is in `api/openapi.yaml`.

## Migration and local verification

API startup never runs migrations. To verify against a throwaway local schema, create `opengym_saas_test` on local MySQL and run:

```sh
cd api
npm run db:generate
SAAS_TEST_DATABASE_URL='mysql://opengym:<password>@127.0.0.1:3306/opengym_saas_test' npm run test:mysql
```

The test runner refuses database names other than `opengym_saas_test` and refuses remote hosts. It runs `prisma migrate deploy` twice and writes only uniquely named test records to this disposable schema. The real-MySQL suite covers Phase 1 lifecycle/audit behavior plus active-session start races, scoped grants, independent and conflicting set writes, idempotency across a fresh process, planned-slot uniqueness, tombstones, event paging, completion races, slot release, and retained client history.

For a later reviewed deployment, use the existing one-shot migration image from the same release and database network, after a coordinated SQL and `/data` backup/restore rehearsal:

```sh
docker compose -f docker-compose.coolify.yml --profile saas-migrate run --rm migrate
docker compose -f docker-compose.coolify.yml --profile saas-migrate run --rm migrate
```

Those commands are documentation only for this task; Phase 2 does not run them against staging or production. Do not enable `COLLAB_WORKOUTS_ENABLED` as part of the migration.

## Rollback and known gaps

For a code rollback, set `COLLAB_WORKOUTS_ENABLED=0` and redeploy. Keep all workout tables and their rows; there is no destructive down migration. Restoring service data requires coordinated MySQL and `/data` recovery.

Deployment remains gated on the Phase 1 two-user/two-tenant negative authorization drill and a coordinated SQL-plus-JSON backup/restore rehearsal. Phase 2 has no WebSocket delivery, offline queue, trainer-wide session list, legacy-history import/export, progression integration, assignment versioning, or billing. Existing solo workout behavior stays on its current local/profile sync path.

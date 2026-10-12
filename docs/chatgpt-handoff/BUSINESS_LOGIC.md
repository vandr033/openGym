# openGym Business Logic

Snapshot: 2026-10-12, main at e8ef703. This documents source-backed behavior. When docs conflict with code, the conflict is called out.

## Roles and scope

- **Guest/local profile**: data belongs to the current browser/native app installation. It has no server identity until the user connects/adopts data.
- **Signed-in profile owner**: controls one profile’s plan, workout history, settings, media and devices. Normal API access is scoped to the authenticated profile ID.
- **Administrator**: trusted instance-level role. Can inspect profiles/history, manage invites, disable/delete other profiles and configure Coach. Admins cannot delete themselves or the last admin. A new profile is not automatically admin.
- **Coach provider/runtime**: configured external service or optional process, used only when enabled and user consent is current; not a user role.
- **Trainer/organization roles**: **UNKNOWN / not implemented** in this snapshot; trainer role appears only in roadmap material.

Sources: api/server.js, README.md, docs/SELF_HOSTING.md, ROADMAP.md.

## Main entities

| Entity | Meaning and important relationships |
|---|---|
| User/profile | Login identity and data ownership boundary |
| Passkey credential | Public credential ID/key, counter and profile ID |
| Invite | Optional one-use signup code with creator/use/revocation data |
| Routine | Reusable exercise prescription: sets, reps/range, load, progression, rest, notes and supersets |
| Week plan | Recurring weekday-to-routine-ID list; a day may combine routines |
| Day override | Date-specific schedule change/rest taking precedence over recurring week |
| Program block | Date-based phases, durations and schedules, optionally deload |
| Active workout | Unfinished device-local session |
| Completed workout | What the user logged, with exercises/sets/PRs/notes/readiness and optional media/Health link |
| Body-weight record | Day/value/edit timestamp, merged by day |
| Custom exercise | Profile-specific movement definition and optional media/link |
| Health record | Separate normalized Apple Health daily/workout summary document |
| Coach job/proposal | Async provider job and pending user decision, separate from the synced workout state |
| Media | Hash-named owner file referenced from profile state |
| Audit event | Auth/admin action metadata in JSON Lines log |

Persistence is JSON, not a relational schema. See TECHNICAL_REFERENCE.md.

## Module status

| Module | Status |
|---|---|
| Plan/routines/program blocks | **IMPLEMENTED_VERIFIED** |
| Guided workouts/history | **IMPLEMENTED_VERIFIED** |
| Progression/analytics | **IMPLEMENTED_VERIFIED** |
| Import/export | **IMPLEMENTED_VERIFIED** |
| Media | **IMPLEMENTED_VERIFIED** |
| AI Coach | **IMPLEMENTED_VERIFIED**, optional |
| Apple Health | **IMPLEMENTED_VERIFIED** on iOS; **PARTIAL** across platforms |
| MCP | **IMPLEMENTED_VERIFIED**, read-only |
| OIDC, trainer role, database, MCP writes/HTTP transport | **PLANNED** where explicitly named; not current |

Corresponding tests and CI checks exist, but were not executed during this analysis.

## Rules future work must preserve

### Planning and session prescription

- Recurring weekdays map to one or more routine IDs. Empty days are rest.
- Date-specific overrides take precedence over recurring schedules. Program phase schedules determine the active schedule by date.
- Planned sessions start from routine targets by default; a setting can carry reps from the last session. Weight/progression is still based on plan and history.
- Exercise-level progression overrides routine-level progression, then mode default. Repetition, timed and cardio modes have different supported policies.
- Deleting a routine removes its references from week lists and date overrides, but completed workouts remain historical records.
- Replacing an exercise preserves only compatible prescription details. Load/flags that do not make sense across loaded/bodyweight/assisted movement types are reset. Progress belongs to a routine slot/exercise context.

Sources: frontend/src/lib/history.js, session-start.js, routines.js, programs.js, session-routines.js.

### Progression

Current policy names: off, linear, Greyskull LP, double, and time. Cardio has no automatic progression policy.

- An unchecked or under-target work set is not a completed success; missing working sets cannot advance progression.
- Warm-up rows do not count as normal work.
- Double progression keeps the load while working through the range. Load rises only after all normal work sets hit the top; reps return toward the bottom.
- Linear progression advances after prescribed work; repeated misses trigger a deload.
- Greyskull LP uses final-set reps and failures in the policy decision.
- Timed progression advances after all holds meet target duration.
- Planned deload/rehab routines excluded from progression do not drive normal targets. Manual exclusion also keeps work out of progression.
- Bodyweight movements can progress via reps and then sets. Per-side movements use side-aware reps. Assistance-machine loads move in the opposite direction from ordinary lifts.
- Progress is derived from logged history, so correcting a saved workout changes later targets.

Sources: frontend/src/lib/progression.js, history.js, workout-model.js, session-start.js, progression.test.js.

### Workout completion/history

- Starting a session builds entries from selected routines, plan, unit/settings, history and progression.
- Active session state stays device-local. Finishing persists a completed workout to profile history.
- Only exercises with completed work remain in the finished session. Saved records preserve actual rows, targets, routine/program context, PRs and supported notes/readiness.
- Readiness does not silently alter the plan. Discomfort is a logging feature and does not offer medical advice.
- Editing a saved workout changes historical facts; downstream progression and records re-read corrected history.
- Media files are separate from workout JSON; only references live in state.

Sources: frontend/src/views/Workout.jsx, frontend/src/lib/finish-workout.js, session-edit.js, history.js.

## Workflows

### 1. Account creation, sign-in and phone pairing

**Trigger/actor:** person creates or signs into profile, or signed-in owner pairs a phone.  
**Preconditions:** matching RP_ID/ORIGIN for passkeys; invite code only when invite-only is enabled; password routes only when PASSWORD_LOGIN is enabled.

1. Registration obtains WebAuthn options. Name is bounded; an invite is checked if required.
2. A short-lived challenge is tied to registration. Verification checks challenge/origin/RP ID and refuses reused credential IDs.
3. User and public credential metadata are stored; invite is marked used.
4. Sign-in issues signed session cookie. “Sign out everywhere” increments profile session version to revoke existing sessions.
5. Pairing begins in a signed-in browser, mints a short-lived one-use code, and redeems on native phone for a bearer token.
6. If local data needs adoption, client waits for explicit user choice before syncing it into the account.

**State/side effects:** db.json, audit events, cookie/token and local remote-state configuration.  
**Failures:** expired challenge, origin mismatch, invalid credential/invite, disabled user, expired pairing or network error. Local data is retained if connection fails.  
**Sources:** api/server.js, api/device-link.js, frontend/src/lib/device-link.js, remote.js, frontend/src/store/useStore.js.

### 2. Plan and run workout

**Trigger/actor:** owner starts a scheduled routine, picks a routine, or logs a past/freestyle workout.  
**Preconditions:** routine contains exercises or user selects a freestyle path.

1. Resolve active schedule from program phase, date override, or weekly plan.
2. Build session entries from routine slots, history, units and progression. Planned values remain distinct from today’s target.
3. User logs sets, may swap exercises, use rest timers, notes and exclusion controls.
4. Finish converts active local state into a saved history record. Incomplete rows are not treated as completed work.
5. PRs/analytics/next progression derive from saved history. Edits/deletions affect later derived numbers.

**Side effects:** local state, optional alerts/media, and profile sync when connected.  
**Failures:** closing before finish leaves active work local; sync failure retains unsent changes with status; no completed work removes an exercise from the saved record.  
**Sources:** frontend/src/sheets.jsx, frontend/src/lib/session-start.js, frontend/src/views/Workout.jsx, finish-workout.js, frontend/src/store/useStore.js.

### 3. Cross-device sync

**Trigger/actor:** signed/paired client saves or polls.  
**Preconditions:** valid profile session/token; adoption decision resolved.

1. Client pushes its copy with baseRev.
2. API validates outer document and workouts/routines list shapes.
3. If revision matches, API removes active, advances server-owned revision, preserves reset marker monotonicity and atomically writes.
4. If stale, API returns 409 with current document; client merges and retries against current revision.
5. Client polls revision while open and on foreground return; full state is fetched when changed.
6. Disconnect/sign-out flows retain unsynced data and expose retry/export/continue options.

**Merge:** union records by ID and edit stamps; bodyweight by day/time; some settings by recency; reset stamps prevent old backups restoring reset items. There are no full delete tombstones, so a concurrent delete can reappear during the conflict window.

**Failures:** stale writes merge; malformed shape is rejected; revoked token keeps local data and asks for pairing/auth; network error leaves data owed.  
**Sources:** api/server.js PUT /api/data, frontend/src/store/useStore.js, frontend/src/lib/sync-merge.js, frontend/src/lib/remote.js.

### 4. Import/export

**Trigger/actor:** owner imports history/routine or exports a backup/training file.  
**Preconditions:** parseable local input; profile session for remote writes.

1. CSV/Hevy data is parsed and mapped to internal exercise IDs; import reports match/unmatched cases.
2. Routine JSON must use opengym-routine-v1. Preview shows exercise matches/schedule changes; owner chooses apply.
3. Name collision defaults to new version; replace keeps old definition archived, updates schedule pointers, and preserves completed workout history.
4. Full backup import checks for remote work that would be lost and offers merge/confirm.
5. Focused data export is user-initiated, date-ranged JSON/CSV. Plan sharing exports plan data, not credentials/media blobs.
6. Mobile auto-backups are local artifacts.

**Failures:** malformed format, ambiguous match, unit mismatch or sync conflict is surfaced; no silent exercise invention.  
**Sources:** docs/DATA_IMPORTS.md, docs/AI_TRAINING.md, frontend/src/lib/routine-import.js, import-csv.js, import-hevy.js, training-export.js, frontend/src/store/useStore.js.

### 5. AI Coach proposal

**Trigger/actor:** profile owner asks for plan/review/debrief or schedule runs one; admin configures provider and limits.  
**Preconditions:** enabled/connected provider, current user consent, allowed credential, caps/concurrency available; runtime provider can drop privileges.

1. Disclosure uses the payload builder’s categories: plan, logged training, body weight, intake/profile answers, and limited preferences.
2. Server builds bounded payload and prompt; arbitrary files are not sent.
3. Provider response is parsed/validated against a closed change list; one repair attempt is allowed.
4. Proposal is held separately pending user decision.
5. Client checks plan fingerprint/staleness; accepted changes are applied locally with snapshot/revert. User history/settings are not changeable by Coach.

**Side effects:** provider receives scoped consented context; server holds job/proposal; ready proposals may trigger push. Only user-applied changes enter synced profile.  
**Failures:** disabled/busy/cap/consent/credential/privilege-drop/timeout/provider/schema failures; raw provider error details are not returned in ordinary user-facing response.  
**Sources:** api/coach/routes.js, jobs.js, api/coach/core/payload.js, validate.js, frontend/src/lib/coach.js, docs/AI_COACH.md.

### 6. Apple Health

**Trigger/actor:** iOS user grants read access and refreshes; paired owner may separately turn on server sync.

1. Native bridge reads HealthKit data. Frontend normalizes and stores it in app-private cache.
2. Web and Android have no HealthKit bridge.
3. Paired server sync sends normalized daily/workout summaries only; raw heart-rate samples are not uploaded.
4. User chooses HealthKit workout association; one external Health ID can link to only one openGym workout.
5. Turning sync off stops future uploads but leaves prior server data. Re-pairing to a new profile requires opt-in again.

**Failures/unknowns:** Apple does not expose a definitive per-type “read denied” response; absent samples can mean no data, denied access or limited history. Failed upload preserves cursor for retry.  
**Sources:** docs/MOBILE.md, frontend/src/lib/health/, frontend/ios/App/App/HealthKitPlugin.swift, api/health-data.js.

### 7. Media upload

Signed-in owner adds exercise/workout media. The server checks type, size, duration, content hash, quota, upload rate/concurrency, and available disk. Files are stored per owner; only that owner can fetch. Supported image/video metadata is stripped on device. Media references live in state, files do not. Unreferenced files age through a grace period before collection. Files are not encrypted at rest.

Failures include disabled uploads, invalid/oversized file, quota/disk limit, rate/concurrency limit, missing file, or proxy timeout.

Sources: api/media.js, api/server.js, frontend/src/lib/media-ingest.js, media-sync.js, docs/SELF_HOSTING.md.

## Validation and permissions

- Password login requires instance switch and profile setup. Password reset codes are admin-issued, single-use.
- Current destructive profile deletion is admin-only; it removes related credentials, profile, health data, Coach auth and media. Self-delete/last-admin delete are refused.
- Admin profile view includes ordinary workout and body-weight data, but omits Apple Health data.
- Audit events include authentication/admin actions. IP detail is off unless configured.
- Push endpoint URLs are an outbound API request boundary; HTTPS and private-address checks mitigate SSRF.
- Main profile state is app-defined JSON with partial outer validation, not a versioned schema service.

## Product questions not answered by source

Target user scale, trainer/org permissions, Health-data retention/deletion UI, email recovery, and multi-instance deployment requirements require product-owner direction.


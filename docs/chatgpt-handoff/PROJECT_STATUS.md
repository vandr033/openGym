# openGym Project Status

**Analysis snapshot:** 2026-10-12  
**Repository:** branch main, commit e8ef703  
**Scope:** source and checked-in documentation/configuration review. This is not a live deployment assessment.

## Status definitions

- **IMPLEMENTED_VERIFIED** — Source implementation exists and repository tests or equivalent checked-in verification evidence support the feature. This label does not mean tests were executed during this handoff.
- **IMPLEMENTED_UNVERIFIED** — Source indicates implementation, but no supporting verification evidence was established in this review.
- **PARTIAL** — A subset of the capability exists, or the capability is limited to specific platforms/configurations.
- **PLANNED** — Explicitly described as future work in project materials and not found implemented in the reviewed snapshot.
- **UNKNOWN** — Repository evidence is insufficient.

## Current implementation

| Area | Status | Evidence and limits |
|---|---|---|
| Accounts, passkeys, optional passwords, pairing | **IMPLEMENTED_VERIFIED** | API routes and frontend flows exist; API/device-link/passkey tests and CI definitions are present. |
| Routines, scheduling, program blocks | **IMPLEMENTED_VERIFIED** | Planning screens and routine/program helpers exist with test coverage. Several roadmap lines are stale because corresponding functionality is already in source. |
| Guided workouts and history | **IMPLEMENTED_VERIFIED** | Session start/finish/edit/history flows and tests exist. Active sessions remain device-local. |
| Progression and analytics | **IMPLEMENTED_VERIFIED** | Progression, 1RM, muscle and activity calculations exist with test coverage. |
| Exercise catalog and custom exercises | **IMPLEMENTED_VERIFIED** | Bundled catalog, localization, custom exercise handling and owner media routes exist. Third-party media rights are distinct from software licensing. |
| Import/export and backup | **IMPLEMENTED_VERIFIED** | CSV/provider imports, routine JSON, focused exports and backup paths exist with docs/tests. |
| AI Coach | **IMPLEMENTED_VERIFIED**, optional | Provider/job/proposal path exists with consent, validation and user apply steps. Actual availability depends on operator configuration/runtime. |
| Apple Health | **PARTIAL** | HealthKit integration is implemented for iOS. Web/Android HealthKit is not present; server upload is separately opt-in. |
| Push and reminders | **IMPLEMENTED_VERIFIED** | Web push and native rest/reminder behavior exist. External subscription endpoints are a security boundary. |
| Admin and audit | **IMPLEMENTED_VERIFIED** | Admin routes and screens support profile inspection and controls; admin access is broad and trusted. |
| MCP bridge | **IMPLEMENTED_VERIFIED**, read-only | Local stdio server and nine read-only tools exist. Some docs/comments still say eight tools. |
| Web/PWA, Docker, Kubernetes sample | **IMPLEMENTED_VERIFIED** as repository configuration | The checked-in artifacts exist; no live deployment was inspected. Kubernetes sample is single-replica. |
| Database-backed persistence | **PLANNED** | Current implementation is JSON files. ROADMAP.md proposes database work; no database/ORM/migration system was found. |
| OIDC, trainer/organization permissions, MCP writes/HTTP | **PLANNED** | Explicit roadmap material only; not current behavior in this snapshot. |
| Android Health Connect | **PLANNED** | Roadmap proposal; no Health Connect implementation found. |

For module details and source locations see PROJECT_CONTEXT.md and BUSINESS_LOGIC.md.

## Changelog and roadmap state

CHANGELOG.md contains an Unreleased section for structured training and AI data tools, including double progression, routine JSON import, program-block changes and additional workout/readiness/export data. Relevant implementation is present in the reviewed source. Treat those items as unreleased repository changes, not as proof of a published release.

ROADMAP.md lists future ideas such as session queues/rotation, advanced programming, database storage, search, OIDC, trainer capabilities, MCP write operations, mobile/health work and catalog improvements. Some entries overlap with features already implemented on main, including program blocks and mobile apps. Roadmap entries are proposals, not delivery dates or commitments. Reconcile the roadmap against source before using it to estimate remaining work.

The MCP README/source also has a count mismatch: current source exposes nine read-only tools, while some documentation says eight.

## Recent repository history

Recent commits at the analyzed HEAD include:

- e8ef703 — UI overhaul
- ca2b9ba — Apple Health
- ce21966 — fixes and changes
- 9cd31ce — reduced container healthcheck
- 5568e4c — Coolify deployment
- 1350409 — website/docs
- 8329189 — diagrams/docs

These messages provide context only; they do not establish release status or current deployment behavior.

## Working tree and scope

The initial repository survey recorded an unstaged change in frontend/ios/App/App/HealthKitPlugin.swift. It changed the native workout HealthKit metric query approach for older iOS versions and added workout-scoped sample querying. At final quality control, git status showed no tracked diff in that file and the working copy matched HEAD. This handoff did not modify the file. Native build/device validation was not performed.

Only documentation under docs/chatgpt-handoff/ was added for this handoff. No application, configuration, dependency, schema, or infrastructure files were intentionally changed.

## Tests and verification evidence

Repository test infrastructure and test files were discovered:

- Frontend: 264 test files identified in the scan; Vitest scripts are defined.
- API: 54 test files identified; Node's built-in test runner is used.
- MCP: one test file identified; Node test script is defined.
- CI: GitHub workflows define frontend/API/MCP checks and image builds; GitLab CI defines mirrored checks and packaging work.

**No tests, builds, locale checks, mobile builds, or deployment checks were executed for this analysis.** The repository's test inventory and CI configuration are evidence that checks exist, not evidence that they pass at this commit. No coverage percentage or pass/fail state is claimed.

A scoped search for TODO/FIXME/XXX in api, frontend/src, mcp, web, scripts, website and kubernetes found no matches. This does not rule out tracked issues, unsearched files, or defects without markers.

## Known issues, debt, and limitations

### Observed in source/docs

- JSON-file persistence is handled by a single Node API process; there is no database, ORM, migration system, or multi-process write coordination.
- Profile writes are bounded by a 5 MB request limit and rely on application-level document validation.
- Concurrent stale writes are merged field-by-field, but there are no complete delete tombstones; a deleted item can reappear after a conflict.
- The ROADMAP and a few MCP tool-count descriptions have drifted from current implementation.
- A single-replica Kubernetes sample is configured; the repository does not provide HA or multi-replica coordination.
- User profile files, health summaries and media are not encrypted at rest by the application.
- Current broad admin access includes inspection of other profiles' workout history and body-weight data.

### Risks to validate operationally

- **P1 — Persistence and growth:** JSON document size, synchronous file operations, and single-process coordination may constrain larger profiles or higher write concurrency. Establish real limits and migration triggers before scaling.
- **P1 — Deployment/data protection:** TLS, correct public origin/passkey settings, proxy trust, backups, restore drills and filesystem access control depend on operator setup. The repository cannot verify production values or backup success.
- **P2 — Conflict semantics:** concurrent deletes can reappear. Define deletion/tombstone behavior if reliable multi-device deletion matters.
- **P2 — Schema evolution:** there is no formal versioned state migration framework. Document and test compatibility when changing stored profile shapes.
- **P2 — Roadmap reliability:** stale roadmap items make planning ambiguous. Reconcile status and ownership before using it as a commitment list.
- **P2 — Native HealthKit change:** the existing unstaged plugin modification has not been validated by an iOS build or device.
- **P3 — Content and localization:** review media usage rights and native/localized UX as distributions expand; repository review cannot determine legal clearance or user impact.

No P0 finding was established from this read-only source review. This is not a security audit or production assurance.

## Prioritized next steps

1. **P1 — Confirm operator controls:** document the expected TLS/proxy setup, trusted proxy behavior, secret and data backup set, restore procedure, and access controls for DATA_DIR.
2. **P1 — Set persistence boundaries:** decide supported profile size/write scale and identify thresholds or telemetry that should trigger a database migration.
3. **P2 — Specify sync deletion semantics:** determine whether tombstones or explicit conflict UI are needed for deletes and resets.
4. **P2 — Reconcile planning docs:** update ROADMAP/MCP tool counts against the current implementation and assign clear status/ownership outside this snapshot.
5. **P2 — Validate native HealthKit work:** run an iOS build and device tests for the unstaged HealthKit plugin change when that work is ready.
6. **P3 — Maintain handoff:** refresh this snapshot after meaningful architecture, product, or release changes.

No dates or estimates are implied.

## Questions for the product owner/operator

- What user/profile count, profile-size ceiling and write concurrency should the system support?
- Is the intended deployment always a trusted single-instance self-hosted server, or is HA/multi-replica operation a goal?
- Who is expected to be an administrator, and should admins continue to have full history/body-weight visibility?
- What are the required data retention, account deletion, export, and backup recovery policies, especially for health data?
- Which roadmap items are active commitments versus exploratory ideas?
- Which AI providers/runtimes are supported in production, and what consent/retention guarantees are expected?
- Is exercise media cleared for the intended distribution and hosting model?
- What iOS versions/devices must be supported for HealthKit?

## What was not examined

No production instance, user interviews, runtime telemetry, external provider account, secrets, or live deployments were accessed. Tests/builds were not run. Repository inspection was broad across app packages, docs, manifests, CI and deployment examples, but this should not be read as exhaustive line-by-line verification of every file.

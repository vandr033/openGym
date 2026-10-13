# Codex Starter Prompt — OpenGym SaaS Phase 0

You are working in my existing customized OpenGym fork. Your task is to prepare a safe, evidence-based implementation plan for turning it into a multi-tenant SaaS with **simultaneous trainer/client editing** and a trainer dashboard that can run multiple clients' workouts concurrently.

**First read the attached `OPENGYM_MULTI_TENANT_CODEX_SPEC.md` in full. Treat it as the approved product and architecture specification.**

## Confirmed requirements

- I am platform super-admin; I create gyms and independent trainer businesses.
- One user can be a trainer at multiple gyms and have an independent trainer business.
- One client may have multiple coaching relationships.
- A trainer can start a workout for a client, log/edit their sets, and see progress in real time.
- Client and trainer can both modify a shared workout simultaneously; independent updates merge, same-record collisions yield version conflicts, not silent overwrites.
- A trainer can operate 10+ separate active client workouts concurrently, without impersonating clients or switching login sessions.
- Client-owned workout history remains theirs if a gym/trainer relationship ends.
- Keep all existing workout behavior, local/offline usage, progression rules, imports, exports and mobile features.

## Your *first* task: Phase 0 ONLY

1. Run `git status`, `git rev-parse HEAD`, and compare actual source to `docs/chatgpt-handoff` (dated prior snapshot). Do not modify or discard uncommitted changes. Note that the public `main` inspected on 2026-10-12 was `0210760a`; HealthKit files present in older documentation had subsequently been removed, so inspect the **actual local branch**.
2. Audit existing auth/session/pairing; profile JSON writes (`/api/data`, `baseRev`, `S.active`); client workout state, start/finish, progression, special set types, history consumers, API docs, Docker/Coolify; and all relevant tests.
3. Return `docs/saas/00-audit.md` with source-path evidence, a concrete migration design, proposed files/interfaces, SQL schema critique, trust boundaries, existing code to reuse, risks and a phase-by-phase PR plan with dependencies.
4. Do not implement Phase 1 or restructure the repository yet. Do not replace `api/server.js`, `useStore.js`, or rewrite `Workout.jsx`. Do not touch native HealthKit as part of this task.
5. Finish with explicit open technical questions and the **smallest safe Phase 1 PR** you recommend, including test commands. Run read-only tests only where safe, and report real results.

The architectural boundary is non-negotiable: new collaborative sessions and operations are server-authoritative SQL records, not whole-profile `/api/data` writes; legacy personal workouts must continue working during migration.

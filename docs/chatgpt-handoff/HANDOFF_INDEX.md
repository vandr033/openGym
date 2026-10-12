# openGym Handoff Index

## Snapshot

- **Analysis date:** 2026-10-12
- **Repository:** openGym
- **Branch / commit:** main / e8ef703
- **Scope:** repository source, documentation, package manifests, tests, CI and deployment examples
- **Working tree note:** the initial survey recorded an unstaged change at frontend/ios/App/App/HealthKitPlugin.swift; final quality control showed no tracked diff in that file. This handoff did not modify it.
- **Verification note:** no tests, builds, locale checks, mobile builds or deployments were run.
- **Purpose:** persistent context for a separate ChatGPT Project; this is a repository snapshot, not a live deployment report.

## Files in this handoff

| File | Purpose | Consult for |
|---|---|---|
| PROJECT_CONTEXT.md | Primary overview of identity, roles, modules, architecture, integrations and unknowns | General project questions, new-assistant orientation |
| TECHNICAL_REFERENCE.md | Detailed stack, repository map, persistence, API/security, configuration, commands and deployment | Engineering implementation, interfaces and operations |
| BUSINESS_LOGIC.md | Entities, training rules, sync semantics, permissions and workflows | Feature planning, acceptance criteria, behavior changes |
| PROJECT_STATUS.md | Module statuses, roadmap drift, recent history, risks, tests and open questions | Prioritization and current-state discussions |
| CHATGPT_PROJECT_INSTRUCTIONS.md | Ready-to-paste behavior instructions for the project assistant | ChatGPT Project setup |
| EXECUTIVE_SUMMARY.md | Short stakeholder summary and recommended priorities | Non-technical sharing and briefing |
| HANDOFF_INDEX.md | This file: navigation, scope and refresh instructions | Upload choices and handoff maintenance |

## Recommended ChatGPT Project setup

Upload all seven files when the Project supports them. If there is a file limit, prioritize:

1. PROJECT_CONTEXT.md
2. BUSINESS_LOGIC.md
3. TECHNICAL_REFERENCE.md
4. PROJECT_STATUS.md

Paste CHATGPT_PROJECT_INSTRUCTIONS.md into the Project Instructions field. The executive summary and this index are useful orientation material but contain some information already summarized in the primary files.

When source access is unavailable, ask the assistant to identify claims as coming from the 2026-10-12 snapshot. Do not treat this handoff as automatically synchronized with the repository.

## Which file to update most often

- Refresh PROJECT_STATUS.md after releases, roadmap decisions, significant commits, CI changes, or new known issues.
- Refresh TECHNICAL_REFERENCE.md after stack, storage, API, security, deployment or command changes.
- Refresh BUSINESS_LOGIC.md after changes to permissions, progression, sync, imports, Health, Coach or other user workflows.
- Refresh PROJECT_CONTEXT.md when identity, roles, module scope or architecture materially changes.
- Refresh CHATGPT_PROJECT_INSTRUCTIONS.md when project constraints or assistant workflow expectations change.
- Regenerate EXECUTIVE_SUMMARY.md from the current status after major product changes.
- Keep HANDOFF_INDEX.md's snapshot metadata, upload guidance and known gaps in sync.

## Known analysis gaps

No production deployment, live service, database instance, external provider account, telemetry, backups, user interviews, or product-owner decisions were inspected. There is no database schema to report: persistence is file-backed JSON. Tests/builds were not run. The review covered the main app packages and deployment/docs paths but was not a line-by-line audit of every file. See PROJECT_STATUS.md for specific scope and risks.

## Refresh process

1. Record the new branch, commit, date and working-tree changes before editing the handoff.
2. Re-read repository guidance, root docs, package manifests, routes, storage/sync code, auth boundaries, test definitions, CI and deployment manifests relevant to the change.
3. Verify behavior in source and current tests; distinguish test files from checks actually executed.
4. Cross-check CHANGELOG.md and ROADMAP.md against implementation, and preserve the distinction between shipped behavior and proposals.
5. Update the relevant files under docs/chatgpt-handoff/ only when producing a new snapshot. Avoid copying secrets or actual environment values.
6. Search for broken cross-references and inconsistent module/status terms.
7. Recheck Git status so unrelated user edits remain untouched.

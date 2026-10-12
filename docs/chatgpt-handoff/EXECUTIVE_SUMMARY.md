# openGym — Executive Summary

**Snapshot:** 2026-10-12, main at e8ef703

openGym is a self-hosted workout and body-weight tracker. People use it to plan routines, record workouts, follow progress, and keep their data on devices or on a server they operate. It runs as a web app/PWA and as iOS and Android apps.

## What it can do

The repository contains working account and passkey flows, routine and program planning, guided workout logging, history and progress views, data import/export, optional AI coaching, push reminders, and an iOS Apple Health connection. A local, read-only MCP bridge can expose selected profile data to compatible AI clients.

A self-hosted instance can hold multiple personal profiles. The code reviewed does not establish organization workspaces, trainer permissions, or a hosted subscription service.

## Current state

The product is substantial and has tests and CI configuration across the frontend, API and MCP packages. The architecture currently stores user state in JSON files and serves it from a Node API. The project includes Docker deployment and a single-replica Kubernetes example.

No tests or builds were run for this handoff, so it makes no claim that the current checks pass. The repository contains an existing unstaged iOS HealthKit change that was not validated.

## Main areas that need attention

- Establish clear operational guidance for securing the server, preserving its signing keys, and backing up/restoring all user data.
- Set supported limits for profile size and write concurrency before scaling; the current file-based design is single-process.
- Clarify how concurrent deletions should behave across devices.
- Bring roadmap and MCP documentation counts in line with the implementation.
- Confirm which future roadmap items are active product priorities.

## Suggested priorities

1. Make deployment, backup and recovery expectations explicit and testable.
2. Define the growth limits of the current persistence design and the point at which a database is needed.
3. Improve sync deletion semantics if users rely on concurrent multi-device edits.
4. Reconcile roadmap status and validate platform-specific changes, including the current iOS HealthKit work.

These are recommendations from repository review, not approved commitments. Production configuration, actual user scale and operator practices were not available for review.

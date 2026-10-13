# OpenGym SaaS — Phase 2.5: invitation-based onboarding and email OTP

**Target branch:** `multitenant` only  
**Baseline reviewed:** `4ddf600890b7b87c182689682fd21318884a92cd`  
**Application:** `entrenamiento.priconpri.com` (SaaS instance)  
**Status:** Implementation specification, not deployed  
**Decisions confirmed:** Email one-time codes for new-user signup and login; phone optional; no SMS OTP; invitation-only registration. Preserve existing passkey users and personal OpenGym `main` unchanged.

## 1. Outcome and non-goals

Build a single, simple experience for inviting an organization owner, trainer, or client, creating or recognizing their account, verifying email, joining the organization, and optionally setting preferences. Owners must manage their organization's invitations from a proper SaaS interface rather than using `/api/admin`, browser consoles, or raw SQL.

Expected inviter interaction:
1. Open **Organization → People → Invite**.
2. Choose `OWNER`, `ADMIN`, `TRAINER`, `STAFF`, or `CLIENT` as permitted by role policy. For clients, choose the trainer who will be associated with that client (rather than silently defaulting to the owner).
3. Enter the target email address. This is **required for the first secure six-digit-code version**. Optionally add a name/message; this must not grant permissions.
4. Generate a single-use invitation containing a secure shareable link and a short six-digit **invitation** code; display expiry and allow copy link/code, resend, revoke, and view status. Emailing the invitation is optional for the inviter; copying and sharing the link should work. The short code is redeemable **only after verification of the email address to which that invitation was bound**. It must be strictly rate-limited. A link embeds a high-entropy one-time secret and is never replaced by the short code as the security boundary.

Expected invitee interaction:
1. Open the link or visit **Join a gym** and enter the invitation code.
2. See organization name, invited role, email address (appropriately masked before verification), and expiration information. Never reveal private tenant details to unauthenticated brute-force callers.
3. Enter/confirm email; request and enter a **separate** six-digit email OTP delivered to that inbox. The invitation code and the email login OTP are distinct values and independent challenges.
4. First-time user: name required, email verified, phone optional, complete minimal preferences (weight units and language; defer training goals, detailed profile, and other optional data). Existing verified user: authenticate via email OTP and accept the invitation without creating a duplicate account.
5. On successful acceptance, show the correct organization and role, then navigate to an appropriate dashboard. For clients: let them explicitly grant trainer `VIEW_TRAINING`, `START_SESSION`, `LOG_SETS` with an expiration choice; **no automatic consent**.

A user may belong to multiple organizations and act in different roles in each. Invitation acceptance cannot create broad platform-admin permissions. Existing accounts and session cookies remain operational throughout.

**Out of scope:** SMS login, billing/subscriptions, mass marketing email, password login, WebSocket live synchronization, offline mutation queue, full gym analytics dashboard, merging solo workout history into collaborative history, account deletion overhaul, public self-service gym creation.

## 2. Current-code constraints to respect

The baseline has:
- Legacy OpenGym identity, `db.json`, user sessions, passkeys, and invitation-only signup in `api/server.js` (the `INVITE_ONLY` flag). An original OpenGym `/api/admin/invites` endpoint is guarded by **legacy admin**, not the independent SaaS `PlatformAdmin` or gym OWNER role. The current owner gets `403` there.
- MySQL SaaS identity/membership/invitation/consent in `api/saas/`, with `User.legacyUidHash` mapped through `ensureIdentity`, `OrganizationInvitation` token hashes, `OrganizationMembership`, `ClientOrganizationEnrollment`, `TrainerClientRelationship`, and `ClientAccessGrant`.
- `POST /api/v2/organizations/:orgId/members/invitations`, `/clients/invitations`, and `/api/v2/invitations/accept` for **existing** authenticated legacy users; owner creation currently uses `ownerLegacyUid`.
- `frontend/src/App.jsx` uses `HashRouter`; `frontend/src/views/Login.jsx` uses passkeys, while `CollabWorkout.jsx` uses `/api/v2/...` and current membership/enrollment data.
- `COLLAB_WORKOUTS_ENABLED` and `SAAS_ENABLED`; production schema has applied Phase 1 and Phase 2, and the SaaS backend currently has working legacy-auth sessions. The SaaS `main`/personal instance must never be touched.

**Architectural requirement:** Do not create a separate OTP-only account silo that cannot use legacy `/api/data`, existing signed sessions, or SaaS `ensureIdentity`. Reuse current account/session issuance, profile-sync and the SQL identity mapping, or implement a carefully tested transitional adapter. No unsafe direct writes to a second store from arbitrary handlers. Account creation + SQL identity + invitation acceptance spans JSON and SQL, so analyze crash/retry behavior and make it idempotent/recoverable; do not claim cross-store atomicity.

**Critical takeover safeguard:** Existing legacy account email fields may be unverified. Email OTP **must not** log a person into or attach an invitation to an existing passkey account by matching an unverified email string. Allow an existing authenticated user to explicitly **link a newly verified email to their current account** (with recent reauthentication as appropriate), or otherwise use a reviewed recovery procedure. Preserve existing passkey credentials and sessions; never overwrite, auto-merge, or relink identities by email alone.

## 3. Invitation and identity model

Design additive Prisma migration(s) with names/types chosen after examining current schema. Suggested concepts:
- `VerifiedEmailIdentity`: normalized email, uniqueness, verifiedAt, userId reference to the single SaaS/legacy-linked user, and optional source metadata; use defined normalization (trim, lowercase domain, case policy) consistently and avoid mailbox-provider-specific dot/plus tricks.
- `UserProfile` or additive fields for optional phone and onboarding completion. Store canonical email verification state in SQL; avoid redundant contradictory profile sources. Use E.164 normalization for phone when provided, but no phone verification or SMS during this phase. Respect existing `User.displayName` + legacy user name and workout preferences; do not duplicate canonical training preferences without a plan.
- `EmailOtpChallenge`: purpose (`SIGNUP`, `LOGIN`, `LINK_EMAIL`, etc.), normalized email or blind identifier, keyed code verifier, expiry, attempt counter, resend state, consumedAt, and abuse/rate-limit metadata; audit safe events without logging OTP values.
- Extend `OrganizationInvitation` or add a secure companion record to support **target email**, one-time high-entropy link secret, optional 6-digit invite-code verification, invited role/trainer, state (`PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`), intended recipient, and expiry. Preserve existing Phase 1 token-based invitations and migration compatibility. Hash secrets at rest. Never expose reusable secret fields in list APIs.
- Optional transactional outbox/durable email dispatch record for invitation/OTP email sending. Failed email delivery must be visible and retryable; never claim successful delivery if provider failed.

Platform admin creates a **new organization with ownerEmail** and sends pending OWNER invitation, without requiring an owner account to already exist. Use the existing audited organization creation policy. A gym OWNER can invite another OWNER/ADMIN/TRAINER/STAFF; never allow gym admins to grant platform administrator privileges. Trainer may invite clients according to current authorization policy. A client invitation must refer to a specific active eligible trainer and the intended organization. Client consent is separate from relationship acceptance.

Invitation email must be bound to a normalized target address; verified email equality is enforced at acceptance. Email OTP proves control of the email address; it does not itself confer invitation permissions. An authenticated existing user accepting an invitation must still prove ownership of the target email (or use an already verified, matching email identity).

## 4. Security and user experience rules

- Feature flags off by default, e.g. `SAAS_EMAIL_OTP_ENABLED=0`, `SAAS_INVITES_V2_ENABLED=0`; gate SaaS-only features so personal/main OpenGym is unaffected. Keep `INVITE_ONLY=1` for production.
- OTP values: CSPRNG-generated six-digit **login email** codes, max 10-minute TTL, single use, up to five verification attempts per challenge, server-side resend cooldown (>=60s), rate limits per email, IP, invite, and global sending limits. Prevent concurrent consumption/replay and OTP replacement races. Codes stored only as keyed HMAC or suitably protected verifier with a non-hardcoded server-side secret. No plaintext values in DB, metrics, HTTP logs, analytics, or errors.
- **Separate invitation codes**: six digits allowed *only* when already scoped to a verified intended recipient and throttled; otherwise require the high-entropy link. Never accept an unbound six-digit code as a standalone authorization token. Links use >=128 bits of CSPRNG entropy (existing Phase 1 token uses 32 random bytes). Single-use and expiry apply equally to link/code paths. Hash at rest.
- Generic responses to untrusted email requests to avoid account enumeration; safe handling for revoked/expired/already-used invitations after adequate verification; HTTP `429` and retry hints for abuse. Strict JSON schemas, body size limits, no unsafe redirect or open redirect, no caching sensitive responses; don't leak link tokens in logs/referrers/third-party scripts.
- HTTPS, same-site signed HttpOnly cookies, existing session invalidation/version semantics and CSRF protection for state-changing endpoints. If email OTP works on native/paired mobile, explicitly support the authenticated bearer-session path safely or document/defer native UI rather than partially breaking it.
- Email is required and verified; phone optional with user-visible privacy notice. Avoid using phone for account lookup/login during this phase.
- Owner/trainer scopes remain governed by organization membership and client consent; never implicitly grant VIEW_TRAINING/LOG_SETS to owner/admin/platform admin. Revocation must immediately stop trainer reads/writes as Phase 2 already enforces.
- Do not disable passkeys. Existing passkey users can continue to log in; adding verified email is an explicit secure step. Do not automatically assign another user's email to an old record.
- Use a production-ready email provider adapter with configurable credentials. No provider chosen yet: implement an interface plus a safe development fake, and document the required production provider configuration; **fail closed in production if email delivery isn't configured**. Do not expose OTPs by console logs in production. Prefer accessible, clear multi-language UI and a smooth six-slot/one-input code entry with paste support.

## 5. API design — illustrative; align with existing route framework

Use explicit endpoints with idempotent handlers and authorization, documented in `api/openapi.yaml`:

**Unauthenticated / pre-auth flow (with anti-abuse):**
- `POST /api/v2/auth/email/request` `{email, purpose, invitationRef?}` → generic accepted response + challenge handle and resendAfter. Never signal whether an email owns an account.
- `POST /api/v2/auth/email/verify` `{challengeId, code, invitationRef?}` → proof of verified email; for existing bound user, issue **existing** OpenGym session; for first-time users return a short-lived limited-scope registration state (not a workout/admin session).
- `GET /api/v2/invitations/preview?token=...` OR `POST /api/v2/invitations/preview` (prefer body to avoid URLs/logs) → minimal masked invitation preview; bind code flow to verified email proof.
- `POST /api/v2/onboarding/complete` `{verifiedRegistrationState, invitationTokenOrReference, name, phone?, preferences?}` → create one linked legacy/SaaS identity and accept invitation idempotently, then issue existing session. New account creation must require a valid invitation when `INVITE_ONLY=1`.

**Authenticated:**
- `POST /api/v2/auth/email/link/request` + `/verify` for binding verified email to current passkey session (step-up as appropriate).
- `GET /api/v2/organizations/:orgId/invitations` list invitation metadata and status (no secrets); scope to owner/admin or authorized trainer's own invitations.
- `POST /api/v2/organizations/:orgId/invitations` `{roleOrClient, email, trainerId?, expiresInDays?}`; returns one-time link/code for copy and optional send status; permissions enforced server-side.
- `POST /api/v2/organizations/:orgId/invitations/:id/resend` and `DELETE /api/v2/organizations/:orgId/invitations/:id` for permitted senders/admins.
- `GET /api/v2/organizations/:orgId/members` or equivalent list with member roles/status; reuse existing client/trainer rosters and permission endpoints as appropriate.
- `POST /api/v2/platform/organizations` ownerEmail version, platform-admin only; do not break existing ownerLegacyUid call until compatibility has been verified.

Exact route names can change to fit project conventions, but document final contracts and maintain backward compatibility for Phase 1 invitations. Reuse acceptance/audit functionality. Validate cross-org scope, invitation target email, trainer assignment, lifecycle state, and idempotency in transactions.

## 6. Screens

**A. SaaS organization management** — from an OWNER/ADMIN navigation entry: overview, **People** tabs `Trainers`, `Clients`, `Team`, `Invitations`. Existing roster and invitation data; create invitation modal with role, email, optional trainer selector, expiry, `Generate invitation`. After creation show `Copy link`, `Copy code`, `Send email` (if provider configured), one-time secret disclosure and expiry. Invite table: recipient masked email as appropriate, role, created/expiry, pending/accepted/expired/revoked, resend/revoke. Owners should not need legacy `/admin` access.

**B. Invitation landing** — `/#/join/<high-entropy-token>` under HashRouter and manual `/#/join` for short code. Show org logo/name if configured, role, email verification prompt. For short code entry, require verified recipient email before redeem. The link token is not an alternative to email verification.

**C. Email sign-in** — simple email input → `Send code` → one input suitable for six digits with paste support; resend after cooldown, error/expired states, and sensible accessible autofill. Existing passkey option stays available for legacy users, but email OTP is the prominent SaaS sign-in path. OTP email contains no session grants.

**D. First-time profile** — full name, verified email (read-only), optional phone, optional display/preferred language and kg/lb. No long questionnaire. On finish show proper organization/role. Existing account goes directly to invitation acceptance, not duplicate signup.

**E. Client consent** — after client joins, optionally show assigned trainer and three explicit independent scopes: view workouts, start sessions, log sets. No prechecked opt-in. Explain expiration and ability to revoke. Do not conflate invite acceptance with permission granting.

## 7. Delivery strategy

Implement on a new branch based on `multitenant`; don't touch `main`. Suggested incremental checkpoints:
1. First output a brief repo audit and concrete implementation plan with migration/JSON-account integration risks.
2. Add verified-email and OTP schema, migration, email provider abstraction, auth endpoints + tests. Keep flags OFF.
3. Implement invitation issuance/acceptance + owner-email organization bootstrap and idempotent cross-store profile onboarding; add integration tests.
4. Implement SaaS management, joining, login, profile, consent UI and API contract, translations.
5. Run local real MySQL and frontend/API regression suites, test recovery/idempotency, build all Docker targets including `linux/amd64`, prepare documentation/operator environment checklist.

Never run production migrations as part of local development. Do not modify `entrenamiento.priconpri.com` or Coolify, commit/push, or deploy without explicit operator instruction. Use the disposable local database `opengym_saas_test`, not `opengym_saas`.

## 8. Verification / acceptance checklist

**Authentication**
- Invited new client and trainer each complete email OTP signup with one shared account recognized by `/api/me`, `/api/data`, `ensureIdentity`, `/api/v2/organizations/me`, and collaborative workouts.
- Existing passkey user links email after authenticating and signs in with OTP to **the same user**, preserving existing workout JSON and membership; unverified legacy email never enables takeover.
- Wrong code, expired code, replay, two requests racing to redeem, concurrent resend/redeem, excessive attempts, provider failure, rate limits, and changing target email all fail safely.
- New account with no valid invitation cannot register when `INVITE_ONLY=1`; signup attempts cannot bypass it via legacy `/api/register/*` or password routes.

**Invitations & authorization**
- Platform admin invites first owner by email to newly created org; gym owner invites trainer and another owner; trainer invites a client only within current permissions.
- Invite is bound to verified target email, role, organization, and optional trainer; accepted only once and audited; revoked/expired cannot be claimed.
- Invite creation/list/revoke respects membership; nonmember/STAFF/other tenant gets 404/403 as appropriate. Multi-tenant users can join two orgs without wrong-org data leakage.
- Clients must explicitly grant each scope; owners/platform admins cannot bypass grant checks. Revoking `LOG_SETS` denies subsequent trainer writes, even with an old UI snapshot.

**Durability & compatibility**
- Cross-store creation crash/retry causes no duplicate users, dangling permission assignments, or orphaned active invitations; detect/reconcile partial states. SQL uniqueness constraints enforce verified-email uniqueness.
- Existing Phase 1 organization records, Phase 2 sessions, passkey accounts, and `/api/data` synchronization are unchanged when feature flags OFF or after rollout.
- Disabling flags restores old behavior without deleting new rows. Email-only accounts must remain able to authenticate appropriately after rollback (document and test an operational rollback path; do not strand them by simply disabling their only login method).
- No SMS needed for optional phone. Sensitive email/phone data is excluded from audit payloads and leaked public responses.

**Validation and handoff**
- Targeted unit tests, full API suite, frontend suite, lint/validation where present, existing Phase 1+2 real-MySQL integration tests, new real-MySQL onboarding tests, Prisma validate/generate and migration replay.
- Docker Compose config and API/migrate/web builds; `linux/amd64` builds for relevant deployable images.
- API OpenAPI spec and operator docs describe mail transport, secret rotation, rate limits, feature flags, delivery failure, user/organization onboarding, safe backup/migration/rollback.
- Report exact changed files, migration name, passing tests, known gaps, and any decisions needed before production; do **not** claim deployment or email delivery was tested without evidence.

## 9. Initial Codex instruction

> Implement Phase 2.5 according to this spec. **Start by auditing the actual HEAD of `multitenant` and reporting any contradictions or unsafe assumptions before editing.** Keep the current production data, signed-cookie sessions, passkeys, `/api/data`, role boundaries, and private `main` instance intact. Reuse proven existing code instead of replacing authentication wholesale. Work only locally on a new branch, keep new features flagged OFF by default, and do not commit, push, or deploy until explicitly authorized. Prioritize security and the one-account cross-store design. If provider configuration or account recovery choices are needed, state them clearly and leave production activation blocked until decided.

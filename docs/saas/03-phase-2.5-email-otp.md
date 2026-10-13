# Phase 2.5: e-mail OTP and invitation onboarding

Phase 2.5 adds verified e-mail identity, recipient-bound invitations, OTP sign-in, first-time onboarding, and SaaS People screens to the existing `multitenant` branch. It does not replace the legacy OpenGym user, session, profile JSON, passkey, or SaaS authorization systems.

## Enablement and Brevo delivery

All new flags are off unless an operator sets them:

```dotenv
SAAS_ENABLED=0
SAAS_EMAIL_OTP_ENABLED=0
SAAS_INVITES_V2_ENABLED=0
INVITE_ONLY=1
COLLAB_WORKOUTS_ENABLED=0
EMAIL_PROVIDER=brevo
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=OpenGym
BREVO_TIMEOUT_MS=10000
BREVO_SANDBOX=0
```

The API uses Brevo's HTTPS transactional endpoint. Without a supported provider and complete valid configuration, OTP operations return a generic `503` before creating a challenge; there is no development transport or provider fallback. API keys and sender settings remain backend-only. `BREVO_SANDBOX=1` adds Brevo's documented `X-Sib-Sandbox: drop` payload header. A sandbox submission is recorded as `SANDBOX`, is not shown as enabled in public app config, and cannot redeem its OTP.

OTP messages have English and Spanish HTML and plain-text templates. Language comes from the request's `Accept-Language`; unsupported languages fall back to English. Codes are never logged. Tests inject a fake provider or fetch function and do not call Brevo.

Delivery status describes provider submission, not inbox delivery: `ACCEPTED` means Brevo accepted the request for processing, `SANDBOX` means Brevo accepted a sandbox request without sending to the recipient, `UNKNOWN` means a timeout/network/5xx left the outcome uncertain, `FAILED` means a definitive rejection, and `SIMULATED` is used only by injected test transports. Ineligible requests remain `SUPPRESSED`; invitations may also be `NOT_SENT` or `UNCONFIGURED`. Provider submission IDs are retained for support. No POST is automatically retried because an ambiguous timeout can follow a successful provider acceptance. Challenges in `UNKNOWN`, `FAILED`, `SANDBOX`, or `SUPPRESSED` state cannot be redeemed; after the existing 60-second cooldown, a new request replaces the prior challenge.

Invitation email links use `PUBLIC_APP_URL`, falling back to `ORIGIN`. Set it to the deployed SaaS origin before sending invitations.

## Identity and data safety

`VerifiedEmailIdentity` is the canonical e-mail login identity in SQL. The legacy `db.json` `user.email` remains an unverified password sign-in field. OTP login never matches it. A person with an old account must sign in through their existing passkey/password, prove control of a new address, and explicitly link it. Linking requires the existing passkey/password step-up.

New profiles get one fixed random legacy UID, one SQL `User`, one verified e-mail, and an initial JSON profile containing only selected units and language. Phone is optional, E.164 only, and is never used for lookup, login, or SMS. Existing JSON users, state files, workouts, passkeys, sessions, and SQL permissions are not rewritten by the additive migration or by feature flags being off. A random-ID collision with existing account or state data is rejected.

SQL cannot transact with the legacy JSON files. The flow commits the SQL identity, verified e-mail, invitation acceptance, and onboarding state first, then writes the legacy user/state files using that same UID. Retries recognize a completed challenge and the JSON provisioning marker; an OTP login can also recover a missing JSON account from the completed SQL record. This is recoverable and idempotent, not cross-store atomic. Back up and restore MySQL and `/data` together.

Invitation acceptance reuses the Phase 2 membership/enrollment/relationship policy and audit trail. A client invite names one active eligible trainer. Acceptance creates the enrollment and relationship only; it creates no `ClientAccessGrant`. Clients opt into `VIEW_TRAINING`, `START_SESSION`, and `LOG_SETS` independently with an expiry, or continue without granting any scope. Owners, admins, and platform admins do not receive implicit workout access.

## Invitations and sign-in

V2 invitations require a normalized target e-mail. Each gets a 256-bit link secret and a separate six-digit code. Only hashes are stored. The code lookup is HMAC-bound to the normalized intended e-mail and is accepted only after the account verifies that address. Link previews reveal only organization name, invited role, masked e-mail, and expiry. Invitation lists never return either secret. Resend rotates both secrets and invalidates the old ones.

Email OTP challenges are random six-digit values, stored as a keyed HMAC, expire after ten minutes, allow five attempts, and have a 60-second resend cooldown. Verification and invitation-code lookup have separate per-address/per-challenge throttles. State-changing browser endpoints keep the existing CSRF checks. The OTP and onboarding routes reuse the normal signed OpenGym session cookie; paired bearer-session clients are not given OTP UI in this phase.

The current limits live in API-process memory and reset on restart. Keep one API replica while these limits are relied upon. Before horizontal scaling, move the counters and resend claims to shared storage and verify concurrency behavior across replicas.

## Local migration and verification

The additive migrations are `api/prisma/migrations/20261013020000_saas_email_otp` and `api/prisma/migrations/20261013030000_saas_email_provider`. They create verified e-mail/challenge tables and nullable invitation/provider metadata; they do not backfill or alter existing user credentials. API startup does not run migrations. Use `SAAS_TEST_DATABASE_URL` only for the guarded local disposable-schema test; never point it at a deployed database. That test applies the full migration chain twice, checks the unique verified-email ownership indexes, races two OTP redemptions through the real MySQL compare-and-swap, and simulates a JSON-store interruption after the SQL onboarding commit before retrying the same registration state. Its mail transport is injected and never contacts Brevo.

The browser sign-in, join, email-link, and People interfaces are desktop-web only for OTP. Native/paired bearer clients keep their existing session flow and need a separately reviewed OTP token-adoption path before native onboarding is enabled.

## Rollback

To stop issuing new e-mail invitations and onboarding while keeping verified-email users able to sign in, set `SAAS_INVITES_V2_ENABLED=0` and leave `SAAS_EMAIL_OTP_ENABLED=1`. This hides the People/join feature and blocks invite-dependent onboarding while retaining OTP login for existing verified accounts.

Do not turn off `SAAS_EMAIL_OTP_ENABLED` or roll the API back to a release without the OTP routes until every OTP-only account has another sign-in method. Users can add a passkey in Settings: a one-use, five-minute e-mail proof is accepted only by the existing passkey-add step-up route, bound to the account, session version, verified e-mail, and one database challenge. Verify that the profile has at least one passkey (or a password enabled under the current password policy) before disabling OTP. Do not delete the new SQL rows during rollback.

## Deployment and limits

- The isolated Coolify development setup, Brevo onboarding, migration, backup, rollback, and smoke-test steps are in [04-brevo-coolify-dev-deployment.md](04-brevo-coolify-dev-deployment.md).
- Rate limits are process-local and reset on restart; keep the API at one replica until shared rate limiting and other distributed requirements are addressed.
- The browser UI is intentionally deferred on native/paired mobile clients.
- Live sender authentication, inbox delivery, Coolify networking, MySQL backup/restore, and deployed WebAuthn behavior require operator verification.

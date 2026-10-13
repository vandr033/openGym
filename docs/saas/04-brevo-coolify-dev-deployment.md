# OpenGym SaaS development deployment: Brevo and Coolify

This runbook prepares the `multitenant` branch for a separate Coolify development stack. It never uses the personal OpenGym application, database, or volumes. The Compose file has top-level project name `opengym-multitenant`; Coolify may normalize generated resource names, so inspect its deployable Compose and actual volume names before the first deploy.

## What is verified and what needs an operator

**Verified from this repository:** the SaaS API uses Prisma migrations, does not migrate at startup, uses `/data` for legacy JSON accounts and sessions, and has an explicit PlatformAdmin provisioning script. The local MySQL test runner refuses remote hosts and any schema except `opengym_saas_test`. The Coolify Compose source contains its own MySQL service, persistent volumes, private service exposure, and a one-shot migration profile.

**Operator-only checks:** GitHub branch availability, Coolify parsing/building, DNS and TLS, Brevo account/domain/sender status, private-network connectivity, live email delivery, persistent storage after redeploy, and backup/restore. No command in this runbook was run against a deployed system.

## 1. Prerequisites

- A Coolify server with Docker Compose support and permission to create a separate project and application.
- Access to the repository and its `multitenant` branch. Work from `origin/multitenant`; do not select `main` or the personal Coolify resource.
- A development hostname such as `saas-dev.example.com`, with DNS access and an HTTPS certificate path.
- A Brevo account with transactional email enabled.
- Two separate strong MySQL passwords: one runtime password and one root password. Create a third password for the migration account. Store all three as Coolify secrets.
- A controlled inbox you own for the initial verified-email and registration checks.

## 2. Prepare Brevo

1. Add the SaaS sending domain in Brevo and publish the exact SPF/DKIM records Brevo provides. Wait until Brevo marks the domain authenticated.
2. Verify a sender address on that authenticated domain, for example `auth@saas-dev.example.com`.
3. Create a transactional API key. Store it in Coolify as `BREVO_API_KEY`; do not place it in the frontend, Git, a build argument, or a `VITE_*` variable.
4. Keep `BREVO_SANDBOX=1` for the sandbox check. Set it to `0` before the real delivery and account-registration checks. Sandbox requests return success without sending a message; they are not evidence of inbox delivery. See [Brevo's transactional email API](https://developers.brevo.com/reference/send-transac-email) and [sandbox mode](https://developers.brevo.com/docs/using-sandbox-mode).

The application sends one request to `POST https://api.brevo.com/v3/smtp/email` using the `api-key` header. It does not retry a POST: a timeout could happen after Brevo accepted the request. Such a challenge is recorded `UNKNOWN` and cannot be redeemed; the next request after the configured cooldown creates a new challenge.

## 3. Create the isolated Coolify stack

1. In Coolify, create a new project named `OpenGym SaaS Development` and a new Git-based Docker Compose application inside it. Do not reuse or edit the personal OpenGym application.
2. Select the OpenGym repository and branch `multitenant`. Set the base directory to the repository root and Compose location to `docker-compose.coolify.yml`. Do not enable Raw/as-is deployment; the normal Git-based Compose application path lets Coolify manage its service and proxy configuration. Review the [Coolify Docker Compose guide](https://coolify.io/docs/applications/builds/docker-compose).
3. Set the API replica count to **one**. Current login, invitation-code, and resend limits live in API-process memory and reset on restart. Multi-replica operation is not supported until limits and other distributed consistency requirements are shared.
4. Add the hostname to the Coolify `web` service on internal port `80`, enable HTTPS, and set `RP_ID` to the hostname only (no scheme or port) and `ORIGIN` to the exact HTTPS origin. `PUBLIC_APP_URL` should be the same origin.
5. For the initial PlatformAdmin bootstrap, keep the domain restricted to your own source IP or behind a temporary access-control layer. You will briefly create one legacy passkey account with `INVITE_ONLY=0`; do not make that temporary open-signup window publicly reachable. Set `INVITE_ONLY=1` before removing the access restriction.
6. Save and inspect Coolify's parsed and deployable Compose. Confirm that `api`, `web`, `media`, `mysql`, and `migrate` are all in this resource; only `web` has a public domain. Confirm there is no published MySQL port. Confirm the `opengym_data`, `opengym_codex`, media, and `opengym_saas_mysql` volumes are managed by this SaaS application and do not resolve to any personal OpenGym volume. Coolify can normalize Compose volume and network names, so verify the actual names in its deployment output and on the server with `docker volume ls` before proceeding. Never select a personal volume or enable automatic deletion of unused volumes. See [Coolify volume behavior](https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts).

`opengym_data` stores the SaaS legacy profiles, passkeys, sessions, profile JSON, and uploads. `opengym_saas_mysql` stores tenant identities, organizations, OTP challenges, invitations, and workout sessions. The exercise-media volumes are seeded by the media service and mounted read-only in `web`. No writable storage is shared with the personal deployment.

## 4. Configure Coolify variables

Set these in the Coolify application's runtime environment. Mark the password and API-key variables as secrets. Do not add any of them as frontend build variables.

| Variable | Development value or format | Purpose |
| --- | --- | --- |
| `RP_ID` | `saas-dev.example.com` | WebAuthn relying-party hostname, without scheme |
| `ORIGIN` | `https://saas-dev.example.com` | Exact public origin used for WebAuthn and secure cookies |
| `RP_NAME` | `OpenGym SaaS` | WebAuthn display name |
| `PUBLIC_APP_URL` | `https://saas-dev.example.com` | Invitation links |
| `TRUST_PROXY` | `1` | Trust the bundled proxy's client-address headers |
| `SESSION_DAYS` | `90` | Lifetime for newly issued sessions |
| `SAAS_ENABLED` | `0` initially, then `1` | SaaS identity, organization, and invitation services |
| `SAAS_EMAIL_OTP_ENABLED` | `0` initially, then `1` | Verified-email OTP routes |
| `SAAS_INVITES_V2_ENABLED` | `0` initially, then `1` | Recipient-bound organization invitations and onboarding |
| `INVITE_ONLY` | `1`; temporarily `0` for private bootstrap only | Requires an invitation for legacy passkey registration |
| `COLLAB_WORKOUTS_ENABLED` | `0` initially | Optional Phase 2 collaborative workout API and UI |
| `SAAS_MYSQL_PASSWORD` | strong runtime password | MySQL image's initial `opengym` user password |
| `SAAS_MYSQL_ROOT_PASSWORD` | different strong password | MySQL root password; used only for initial DB-user setup and administration |
| `SAAS_DATABASE_URL` | `mysql://opengym:<url-encoded-runtime-password>@mysql:3306/opengym_saas` | Runtime API database connection |
| `SAAS_MIGRATION_DATABASE_URL` | `mysql://opengym_migrator:<url-encoded-migration-password>@mysql:3306/opengym_saas` | One-shot migration connection; not passed to the API |
| `EMAIL_PROVIDER` | `brevo` | Explicit transactional provider selection; no fallback |
| `BREVO_API_KEY` | Brevo transactional API key | Backend-only provider credential |
| `BREVO_SENDER_EMAIL` | verified sender address | Authenticated sender address |
| `BREVO_SENDER_NAME` | `OpenGym` | Sender display name |
| `BREVO_TIMEOUT_MS` | `10000` | Provider request timeout (allowed range: 1000–60000 ms) |
| `BREVO_SANDBOX` | `1` for sandbox, then `0` | Adds Brevo's sandbox payload header; sandbox requests do not deliver mail |

The Coolify Compose file fixes container paths and defaults optional logging, locale, and web proxy values. The application reads `DATA_DIR=/data`; do not point it at the personal app's storage. Do not set `DATABASE_URL` directly in Coolify: Compose maps `SAAS_DATABASE_URL` to the API's `DATABASE_URL` and uses the migration URL only for the migration service.

Set the database URLs with URL-encoded passwords. Use the private Compose service hostname `mysql`, database `opengym_saas`, and port `3306`; do not publish this port. Keep `SAAS_ENABLED`, `SAAS_EMAIL_OTP_ENABLED`, `SAAS_INVITES_V2_ENABLED`, and `COLLAB_WORKOUTS_ENABLED` off until the migration and bootstrap steps are complete.

Optional existing OpenGym settings passed by this Compose file include `PORT`, `NGINX_PORT`, `BACKEND`, `DEFAULT_LANG`, `ALLOW_GUEST`, `PASSWORD_LOGIN`, `ADMIN_UIDS`, `AUDIT_LOG`, `AUDIT_MAX`, `AUDIT_DAYS`, `AUDIT_IP`, `VAPID_SUBJECT`, `COACH_DISABLED`, `CF_CONNECTING_IP`, `BASE_PATH`, and `MEDIA_UPLOAD_MAX`. `COACH_DISABLED=1` is recommended for this first development deployment. `ADMIN_UIDS` grants legacy OpenGym admin UI access; it does not grant SaaS `PlatformAdmin` permissions.

## 5. Start MySQL and separate migration permissions

1. Deploy the stack once with SaaS feature flags off. Wait until MySQL is healthy and the API and web containers are running. The MySQL service has no host-published port. This isolated stack starts MySQL with `log_bin_trust_function_creators=1`, which lets the restricted migration user install the checked-in triggers while binary logging is enabled.
2. Connect to MySQL from its container using Coolify's service terminal or the deployment host. Use an interactive password prompt so the root password is not part of a command or deployment log:

   ```sh
   docker compose -f docker-compose.coolify.yml exec mysql mysql -uroot -p
   ```

3. In the MySQL prompt, create the migration account and reduce the runtime account to data access. Replace the two SQL password placeholders with the raw passwords stored in Coolify; the connection URLs use their URL-encoded forms.

   ```sql
   CREATE USER 'opengym_migrator'@'%' IDENTIFIED BY '<migration-password>';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER
     ON opengym_saas.* TO 'opengym_migrator'@'%';
   REVOKE ALL PRIVILEGES ON opengym_saas.* FROM 'opengym'@'%';
   GRANT SELECT, INSERT, UPDATE, DELETE ON opengym_saas.* TO 'opengym'@'%';
   SHOW GRANTS FOR 'opengym_migrator'@'%';
   SHOW GRANTS FOR 'opengym'@'%';
   ```

   The runtime user receives DML privileges only. The migration user receives the schema privileges needed by checked-in migrations, including `TRIGGER` for append-only audit/event triggers. MySQL 8.4 binary logging and trigger privileges are described in the [MySQL trigger reference](https://dev.mysql.com/doc/refman/8.4/en/create-trigger.html) and [stored-program binary logging reference](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html). If using an externally managed database, ask its administrator to enable the equivalent setting for the migration window; do not grant `SUPER` to the runtime user.

   MySQL image variables initialize users only when the data directory is first created. Changing `SAAS_MYSQL_PASSWORD` or `SAAS_MYSQL_ROOT_PASSWORD` later does not rotate existing MySQL accounts. Rotate the SQL account and Coolify URL together, and never delete the volume to resolve an authentication error.

## 6. Run Prisma migrations explicitly

Use the migration profile from the same repository revision and the same private Compose network:

```sh
docker compose -f docker-compose.coolify.yml --profile saas-migrate run --rm migrate
docker compose -f docker-compose.coolify.yml --profile saas-migrate run --rm migrate
```

The first run applies all checked-in migrations in sequence; the second should report no pending migrations. The API startup does not run migrations. The command uses `SAAS_MIGRATION_DATABASE_URL`; it does not reset tables or data. Do not run `prisma db push`, `prisma migrate dev`, `docker compose down -v`, or a database reset against this deployment.

The checked-in migration chain includes tenant identity/audit, Phase 2 workout sessions, Phase 2.5 verified-email OTP, and provider submission IDs. If a migration fails, keep the database and volumes intact, save the full diagnostic output, confirm the database and migration-user grants, and fix forward with a reviewed migration or a verified backup restore. Do not edit `_prisma_migrations` by hand.

## 7. Bootstrap the first PlatformAdmin

An invitation-only system needs an administrator who can issue the first invitation. The bootstrap script promotes an already-created active legacy OpenGym account; it does not create a passkey or account.

1. While the hostname remains access-restricted, temporarily set `INVITE_ONLY=0` and deploy. Leave the SaaS feature flags off.
2. Open the HTTPS development site and create one passkey account. Get its legacy user ID from the signed-in browser's `GET /api/me` response (`user.id`). Do not use an account, data directory, or session from the personal OpenGym deployment.
3. Set `SAAS_ENABLED=1` and deploy the API. Run the repository's provisioning script in the API container:

   ```sh
   docker compose -f docker-compose.coolify.yml exec api \
     node scripts/provision-platform-admin.js <legacy-user-id> --by coolify-initial-bootstrap
   ```

   The script reads the active account from this stack's `/data/db.json`, ensures the SQL identity mapping, and writes the PlatformAdmin grant and audit event. `ADMIN_UIDS` and the legacy `user.admin` flag do not substitute for this grant.

4. Confirm that the newly created account can open the Organization screen as a PlatformAdmin. Then set `INVITE_ONLY=1` and redeploy. Keep the access restriction until Brevo, email linking, and invitation checks are complete.
5. Configure Brevo with `BREVO_SANDBOX=1`, `SAAS_EMAIL_OTP_ENABLED=1`, and `SAAS_INVITES_V2_ENABLED=1`. From the restricted Organization screen, create a test organization invitation with “Send invitation e-mail”; confirm the status is `SANDBOX`. No recipient receives a message and that invitation cannot establish ownership.

If the provider is in sandbox mode, `/api/config` intentionally does not advertise the OTP or invite UI. The Organization page can still be opened directly at `https://<hostname>/#/organization` while signed in as the PlatformAdmin to submit the sandbox invitation. Revoke the test invitation or rotate it before using that address for a real invite.

## 8. Test real OTP delivery and invitation onboarding

1. Verify the authenticated domain and sender in Brevo. Set `BREVO_SANDBOX=0`, confirm the sender and API key are correct, and redeploy. Keep the hostname access-restricted during these tests.
2. In the PlatformAdmin account's Settings, open **Verified e-mail**, prove account ownership with the existing passkey, and request a code for the controlled inbox. Verify the code. A successful application response means the OTP was accepted and verified; a Brevo `ACCEPTED` submission by itself never proves ownership.
3. Sign out, return to Login, and test email-code sign-in to that verified address. Confirm that a wrong code, expired code, and replay fail. The UI states the ten-minute expiry and supports a resend after the 60-second cooldown.
4. As PlatformAdmin, create a development gym and send the first owner invitation to a controlled address. Complete the invitation flow from its link or recipient-bound code. Confirm refresh/retry during onboarding reuses the signed registration state and does not create a second account.
5. As the gym owner, invite a trainer and verify the trainer account with the invited email. Have the trainer invite a client and select the intended trainer relationship. A mismatched email must not accept the invitation.
6. As the client, accept the invitation and continue without choosing permissions. Confirm the trainer has no private workout access. Then grant only one scope, verify only that scope works, and revoke it; access should stop immediately. Membership and enrollment alone must not create a private workout grant.
7. To exercise the Phase 2 workout API and UI, set `COLLAB_WORKOUTS_ENABLED=1` only for this development drill, redeploy, and repeat the denial, scoped-grant, and revocation checks. Turn it back off unless the development deployment is intentionally testing collaboration.
8. Add a second passkey to the initial email-only test account using email step-up. Confirm that an expired, replayed, session-mismatched, or revoked-session proof cannot add a passkey.
9. After testing, remove the temporary source-IP restriction only if the hostname is intended to be reachable, and keep `INVITE_ONLY=1`.

Provider statuses distinguish `ACCEPTED` (Brevo accepted for processing), `SANDBOX` (test request accepted with no delivery), `UNKNOWN` (outcome uncertain), and `FAILED` (definite rejection). None of these statuses confirms inbox delivery. Check the controlled inbox and provider account separately.

## 9. Check persistence after redeploy

Before the first deploy, capture the actual Coolify volume names for `/data` and `/var/lib/mysql`. Create a test profile and organization, redeploy the same branch without changing the Compose project or volumes, and confirm both remain. Also confirm exercise media persists. Do not test this by deleting the volumes. Coolify storage is persistent but is not itself a backup; see its [storage backup guidance](https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts).

Keep one API replica. Existing rate limits are process-local. Coolify preview deployments must not be configured to share these writable volumes with this stack or with the personal app.

## 10. Back up and roll back

- Take a coordinated backup of the SaaS `/data` volume and a MySQL logical backup before migrations or upgrades. Stop API writes during the pair of backups if the same account/onboarding may be writing both stores. The application explicitly does not promise cross-store atomicity.
- Use Coolify's supported volume backup for the API data volume and an application-aware MySQL dump for `opengym_saas`. Do not archive a live MySQL data directory as the only database backup.
- Test restores into separate development volumes/database names before replacing the current stack. Keep the original volumes until the restored application has passed login, onboarding, invitation, and consent checks.
- A behavior rollback can set `SAAS_ENABLED=0`, `SAAS_EMAIL_OTP_ENABLED=0`, `SAAS_INVITES_V2_ENABLED=0`, and `COLLAB_WORKOUTS_ENABLED=0`, then redeploy the previous reviewed app revision. Keep both data stores and migration history. Do not turn OTP off for OTP-only users until they have another sign-in method.
- The migrations are additive and have no automatic down path. For a failed migration, preserve its diagnostics and database, and restore a verified backup only after identifying exactly which volumes/database are involved. Never reset the development database automatically.

## 11. Troubleshooting

| Symptom | Check |
| --- | --- |
| OTP controls are absent | `GET /api/config`; confirm SaaS/OTP/invitation flags, complete Brevo configuration, and `BREVO_SANDBOX=0`. Sandbox deliberately hides those controls. |
| Email request returns 503 | Check `EMAIL_PROVIDER=brevo`, the backend-only API key, sender address, timeout/sandbox values, `SAAS_DATABASE_URL`, MySQL health, and migration status. Unconfigured OTP routes fail closed before inserting a challenge. |
| Email code request returns generic 202 but no message | Confirm the address is a verified SaaS identity or the invitation's target address; inspect the internal challenge status and redacted provider log; check Brevo sender authentication and provider account status. Generic responses do not disclose account existence. |
| Provider status is `UNKNOWN` | A timeout/network error/5xx left acceptance uncertain. The challenge is not redeemable. Do not retry the same POST. Wait for the cooldown and request a new code; the new challenge replaces the earlier one. |
| Brevo returns HTTP 400 | Check the sender is verified, sender syntax, recipient, JSON content, and Brevo account settings. Provider response bodies are intentionally not copied into application logs. |
| Brevo returns HTTP 401 or 403 | Replace a revoked/wrong API key or verify the key has transactional-email access and the sender/domain is authorized. |
| Brevo returns HTTP 429 or 5xx | Check account limits/status. The adapter does not retry an email POST; wait for the app cooldown and make a new request. |
| Sandbox has a success response but no mail | Expected: Brevo sandbox `drop` mode sends no email and the OTP is not redeemable. Set sandbox to `0` for controlled-inbox delivery. |
| WebAuthn says the origin/RP ID is invalid | `ORIGIN` must exactly match the HTTPS page origin; `RP_ID` must be its hostname, without scheme or port. Confirm Coolify's proxy terminates TLS and forwards the request to `web:80`. |
| API reports database unavailable or access denied | Confirm `mysql` is healthy, the API URL uses `mysql:3306/opengym_saas`, the password is URL-encoded in each URL, and runtime grants are DML-only. Apply pending migrations through the one-shot migration service. |
| Migration fails while installing audit triggers | Confirm the migration URL is the migrator account and it has `TRIGGER` plus DDL privileges. If MySQL reports a binary-log restriction, ask the DB administrator to review MySQL 8.4 trigger/binary-log policy; do not give the API runtime account `SUPER`. |
| Invite link opens the wrong host | Set `PUBLIC_APP_URL` to the SaaS HTTPS origin and redeploy; invitation links fall back to `ORIGIN`. |
| Data appears missing after redeploy | Stop before deleting anything. Compare Coolify's deployable Compose volume names and the actual Docker volume list with the recorded names; Coolify may normalize managed Compose volume names. Restore only from a verified backup. |

## 12. Manual setup checklist

1. In GitHub, review this local `multitenant` change and push it only when you approve it; then connect that branch to the new Coolify application. No code is pushed by this runbook.
2. In DNS, create the SaaS development hostname and complete HTTPS/TLS setup. Keep access restricted during first-account bootstrap.
3. In Brevo, authenticate the sending domain, verify the sender, create the transactional API key, and store it only in Coolify secrets.
4. In Coolify, create a separate project/resource, select `multitenant` and `docker-compose.coolify.yml`, set one API replica, configure the exact hostname/RP ID/origin, and verify that generated MySQL/data/media volumes are unique.
5. Set unique root/runtime/migration passwords and the two private database URLs. Create the migration SQL account, apply migrations twice, bootstrap a PlatformAdmin, and enable invite-only mode before removing the access restriction.
6. Run the Brevo sandbox submission, then set `BREVO_SANDBOX=0` and verify real OTP delivery to your controlled inbox. Test new registration, invitations, trainer/client consent, first-passkey step-up, and persistence after redeploy.
7. Save coordinated backups of `/data` and MySQL and confirm you can restore them into separate development resources.

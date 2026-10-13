# Phase 1: MySQL and tenant identity deployment

Phase 1 is off by default. It adds a private MySQL volume for tenant identity and permissions while keeping profiles, credentials, workout history, and backups in the existing `DATA_DIR` JSON files. API startup does not run Prisma migrations.

## Local Compose

Set these values in `.env` (URL-encode the password in `SAAS_DATABASE_URL`):

```dotenv
SAAS_ENABLED=0
SAAS_MYSQL_PASSWORD=<long-random-password>
SAAS_DATABASE_URL=mysql://opengym:<url-encoded-password>@mysql:3306/opengym_saas
```

Start MySQL with its private Compose profile, then back up `./data` and the SQL volume before applying schema changes:

```sh
docker compose --profile saas up -d mysql
docker compose --profile saas --profile saas-migrate run --rm migrate
docker compose --profile saas --profile saas-migrate run --rm migrate
```

The migration command is a one-shot image built from `api/Dockerfile`'s `migrate` target. Running it twice verifies Prisma has no unapplied migration on the second run. The regular API and web services do not depend on it.

Provision a platform administrator separately, using the existing OpenGym user ID and an operator identifier:

```sh
docker compose exec api node scripts/provision-platform-admin.js <legacy-user-id> --by <operator-id>
```

The script reads only the active account identity from `/data/db.json`, creates the SQL mapping if needed, and grants the independent `PlatformAdmin` role. `ADMIN_UIDS` and `user.admin` do not grant this role. Repeating the command does not duplicate the role or audit entry.

## Real MySQL integration check

Use a disposable MySQL schema named `opengym_saas_test` and provide its connection string as `SAAS_TEST_DATABASE_URL`:

```sh
cd api
SAAS_TEST_DATABASE_URL='mysql://opengym:<password>@127.0.0.1:3306/opengym_saas_test' npm run test:mysql
```

The command refuses any other database name, applies the checked-in migration to that test schema, and exercises the real invitation, authorization, consent, deactivation/deletion, and audit-trigger paths. It leaves uniquely named test rows in that disposable schema; do not point it at an application database.

For MySQL 8.4 with binary logging enabled, configure the disposable server with `log_bin_trust_function_creators=1` so the migration user can install the append-only triggers without `SUPER`. The dedicated Coolify stack sets this on its isolated MySQL service; do not change the personal deployment's database for this SaaS test.

After verifying the migration and provisioned account, set `SAAS_ENABLED=1` and recreate the API container. If the database is unavailable, SaaS routes return 503 while the existing JSON API remains available. Setting the flag back to `0` stops the tenant endpoints; it does not delete SQL data.

## Coolify

Use [04-brevo-coolify-dev-deployment.md](04-brevo-coolify-dev-deployment.md) for the dedicated SaaS Coolify stack. `docker-compose.coolify.yml` has the project name `opengym-multitenant`, a private MySQL service, and its own JSON, MySQL, and exercise-media volumes. It is separate from the personal Compose project. Do not change the project name or publish MySQL port 3306.

Normal deployments do not run migrations. After creating the stack's MySQL users and configuring `SAAS_MIGRATION_DATABASE_URL`, run the one-shot migration service explicitly from the same revision being deployed:

```sh
docker compose -f docker-compose.coolify.yml --profile saas-migrate run --rm migrate
```

Run that command a second time and confirm it reports no pending migrations. The full runbook covers the initial account, least-privilege migration user, PlatformAdmin bootstrap, feature flags, and backups.

Use the normal API image for application traffic; it contains the generated Prisma Client but not the Prisma migration CLI. The separate `migrate` target carries the CLI for this explicit operation. Do not run `prisma db push` or `migrate dev` against a deployed database.

## Rollback and restore

To roll back application behavior, set `SAAS_ENABLED=0` and redeploy. Keep `SAAS_DATABASE_URL` configured while the SQL store contains mapped accounts: legacy account disable/delete operations use it to revoke tenant memberships, relationships, invitations, and grants, and fail closed if that store is unavailable. Keep the MySQL volume and migration history intact; Phase 1 migrations are additive and have no down migration. Restore the existing JSON files and the tenant database from backups taken at a consistent point. JSON-only restore does not restore tenant membership or consent data.

This phase stores no workout sessions and imports no history. Do not enable later collaborative workout writes until a coordinated JSON/MySQL backup and restore rehearsal has been completed.

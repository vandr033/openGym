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

After verifying the migration and provisioned account, set `SAAS_ENABLED=1` and recreate the API container. If the database is unavailable, SaaS routes return 503 while the existing JSON API remains available. Setting the flag back to `0` stops the tenant endpoints; it does not delete SQL data.

## Coolify

Keep the MySQL service on the Compose private network and do not publish port 3306. Configure `SAAS_MYSQL_PASSWORD` and `SAAS_DATABASE_URL` as secrets/environment values. The `mysql` service uses the `saas` profile; `migrate` uses the separate `saas-migrate` profile, so normal deploys do not migrate automatically.

For the first deployment, make a consistent backup of the existing data volume and a MySQL snapshot/dump if the SQL volume already exists. Run the one-shot migration service explicitly from the same revision being deployed:

```sh
docker compose -f docker-compose.coolify.yml \
  --profile saas --profile saas-migrate run --rm migrate
```

Run that command a second time and confirm it reports no pending migrations. Provision the platform admin with the same command shown above using the API container, then enable `SAAS_ENABLED=1` in Coolify and redeploy the API.

Use the normal API image for application traffic; it contains the generated Prisma Client but not the Prisma migration CLI. The separate `migrate` target carries the CLI for this explicit operation. Do not run `prisma db push` or `migrate dev` against production.

## Rollback and restore

To roll back application behavior, set `SAAS_ENABLED=0` and redeploy. Keep `SAAS_DATABASE_URL` configured while the SQL store contains mapped accounts: legacy account disable/delete operations use it to revoke tenant memberships, relationships, invitations, and grants, and fail closed if that store is unavailable. Keep the MySQL volume and migration history intact; Phase 1 migrations are additive and have no down migration. Restore the existing JSON files and the tenant database from backups taken at a consistent point. JSON-only restore does not restore tenant membership or consent data.

This phase stores no workout sessions and imports no history. Do not enable later collaborative workout writes until a coordinated JSON/MySQL backup and restore rehearsal has been completed.

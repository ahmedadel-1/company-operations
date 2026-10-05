-- Generated with `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, then
-- extended by hand with the statements marked "Hand-written" (not expressible in schema.prisma).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Hand-written: required extensions (DATA_MODEL §12). All three are trusted extensions, so the
-- database owner (ops_migrator) can create them without superuser rights.
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "PlatformAuditActorType" AS ENUM ('USER', 'SYSTEM', 'CLI');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "time_zone" TEXT NOT NULL,
    "work_week" SMALLINT[],
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "setup_state" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "idp_issuer" TEXT NOT NULL,
    "idp_subject" TEXT NOT NULL,
    "email" CITEXT,
    "display_name" TEXT NOT NULL,
    "platform_role" "PlatformRole",
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'INVITED',
    "invited_by_member_id" UUID,
    "authz_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_key" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_member_id" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_member_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "request_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "PlatformAuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "target_organization_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_idp_issuer_idp_subject_key" ON "users"("idp_issuer", "idp_subject");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_id_key" ON "organization_members"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_id_key" ON "roles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_key_key" ON "roles"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_organization_id_id_key" ON "role_permissions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_organization_id_role_id_permission_key_sco_key" ON "role_permissions"("organization_id", "role_id", "permission_key", "scope");

-- CreateIndex
CREATE INDEX "member_roles_organization_id_role_id_idx" ON "member_roles"("organization_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_roles_organization_id_id_key" ON "member_roles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_roles_organization_id_member_id_role_id_key" ON "member_roles"("organization_id", "member_id", "role_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_entity_type_entity_id_idx" ON "audit_logs"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_actor_member_id_created_at_idx" ON "audit_logs"("organization_id", "actor_member_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_organization_id_id_key" ON "audit_logs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_organization_id_created_at_idx" ON "platform_audit_logs"("target_organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_invited_by_member_id_fkey" FOREIGN KEY ("organization_id", "invited_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_organization_id_granted_by_member_id_fkey" FOREIGN KEY ("organization_id", "granted_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_target_organization_id_fkey" FOREIGN KEY ("target_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints.
ALTER TABLE "organizations" ALTER COLUMN "work_week" SET NOT NULL;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_work_week_check"
  CHECK (cardinality("work_week") BETWEEN 1 AND 7 AND "work_week" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]);
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_check"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_time_zone_check" CHECK (length("time_zone") BETWEEN 1 AND 64);
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_default_locale_check" CHECK ("default_locale" IN ('en', 'ar'));
ALTER TABLE "users" ADD CONSTRAINT "users_idp_identity_check"
  CHECK (length("idp_issuer") BETWEEN 1 AND 512 AND length("idp_subject") BETWEEN 1 AND 255);
ALTER TABLE "roles" ADD CONSTRAINT "roles_key_check" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,63}$');
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_check"
  CHECK ("permission_key" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$');
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$');
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_action_check"
  CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$');

-- Hand-written: append-only audit tables (SECURITY §8). The trigger applies to every role,
-- including the table owner; the grants below additionally remove the privileges from ops_app.
CREATE FUNCTION "forbid_append_only_mutation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "platform_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "platform_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "platform_audit_logs_no_truncate" BEFORE TRUNCATE ON "platform_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: least privilege for the runtime role (SECURITY §8). Default privileges from
-- infra/docker/postgres/init grant DML on new tables to ops_app; narrow them where the app must not
-- write. Skipped where the role does not exist (deployments with other role names apply equivalent grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs", "platform_audit_logs" FROM ops_app;
    REVOKE ALL ON "_prisma_migrations" FROM ops_app;
  END IF;
END;
$$;

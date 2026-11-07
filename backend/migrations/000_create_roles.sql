-- SiliconScope AI — Role Provisioning
-- Migration: 000_create_roles.sql
--
-- Run as a PostgreSQL superuser (postgres) BEFORE 001_initial_schema.sql.
-- Safe to rerun: each DO block checks for role existence before creating.
--
-- This script creates the two roles defined in ARCHITECTURE.md §6.1:
--
--   sscope_migrations  DDL account — owns the schema, runs all migrations.
--   sscope_app         Application runtime account — DML only, no DDL, no DELETE.
--
-- Neither role receives a password here. The operator sets passwords separately
-- in the target database before any connection is made:
--
--   ALTER ROLE sscope_migrations WITH PASSWORD '<strong-random-password>';
--   ALTER ROLE sscope_app       WITH PASSWORD '<strong-random-password>';
--
-- Never store passwords in version-controlled files.
--
-- After running this script, the DBA must create and hand ownership of the
-- database to sscope_migrations, then transfer the public schema:
--
--   CREATE DATABASE sscope OWNER sscope_migrations;
--   \c sscope
--   ALTER SCHEMA public OWNER TO sscope_migrations;
--
-- Then apply the schema migration under the migrations account:
--
--   psql -U sscope_migrations -d sscope -f migrations/001_initial_schema.sql
--
-- The application account (sscope_app) must never run migrations.
-- Running migrations under sscope_app would require granting it DDL privileges,
-- violating the minimum-privilege policy (ARCHITECTURE.md §6.1, SECURITY.md §12.3).

-- ── sscope_migrations ─────────────────────────────────────────────────────────
-- DDL account. Owns and migrates the schema. Grants runtime privileges to
-- sscope_app. Must NOT be used as the application runtime account.
-- NOINHERIT: cannot acquire privileges of any role it is a member of.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sscope_migrations') THEN
    CREATE ROLE sscope_migrations WITH LOGIN NOINHERIT;
  END IF;
END
$$;

-- ── sscope_app ────────────────────────────────────────────────────────────────
-- Application runtime account. Receives DML-only grants from 001_initial_schema.sql:
--   SELECT, INSERT on devices, sessions, benchmark_cases, comparisons
--   UPDATE (api_key_hash) on devices only
--   No DELETE on any table. No DDL (CREATE/DROP/ALTER). No GRANT.
-- NOINHERIT: cannot acquire privileges of any role it is a member of.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sscope_app') THEN
    CREATE ROLE sscope_app WITH LOGIN NOINHERIT;
  END IF;
END
$$;

-- SiliconScope AI — Initial Schema
-- Migration: 001_initial_schema.sql
--
-- Amendments applied:
--   CX-S-2  (2026-11-02): provenance trigger targets `sessions`, not `runs`
--   CX-S-4  (2026-11-02): narrowed grants — SELECT/INSERT only; UPDATE limited to
--                          api_key_hash column on devices; no DELETE granted
--
-- Run once against a fresh PostgreSQL database as a superuser, then grant
-- the sscope_app role per §2.5 below.

BEGIN;

-- ── Extension ─────────────────────────────────────────────────────────────────
-- gen_random_uuid() requires pgcrypto (PostgreSQL < 14) or is built-in (>= 14).
-- Safe to call unconditionally; CREATE EXTENSION IF NOT EXISTS is idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── devices ───────────────────────────────────────────────────────────────────
-- Stores registered agent machines.  ARCHITECTURE.md §6.1.
-- api_key_hash: bcrypt(cost >= 12) of the 256-bit random key issued at
-- registration.  The raw key is NEVER stored here (SECURITY.md §5.1).
CREATE TABLE devices (
    device_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_name     TEXT        NOT NULL,
    api_key_hash    TEXT        NOT NULL,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── sessions ──────────────────────────────────────────────────────────────────
-- One row per benchmark run submitted by a device.
-- Reflects: BD-2 (import_environment), CX-ARCH-1 (no sync_reason — SQLite only),
--           CX-ARCH-2 (no aggregate_name at case level — it lives in measurements JSONB).
CREATE TABLE sessions (
    session_id          UUID        PRIMARY KEY,
    device_id           UUID        NOT NULL REFERENCES devices(device_id),
    run_name            TEXT        NOT NULL,
    os_name             TEXT        NOT NULL,
    os_version          TEXT        NOT NULL,
    cpu_name            TEXT        NOT NULL,
    isa                 TEXT        NOT NULL,
    build_type          TEXT        NOT NULL,
    source              TEXT        NOT NULL
                            CHECK (source IN ('synthetic', 'user-supplied import')),
    source_marker       TEXT,
    git_sha             TEXT,
    build_config        TEXT,
    import_timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
    import_environment  JSONB,
    content_fingerprint TEXT        NOT NULL,
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- content_fingerprint is NOT globally unique — session-scoped dedup only.
-- Two distinct session_ids may have the same fingerprint (legitimate re-runs).

-- ── benchmark_cases ───────────────────────────────────────────────────────────
-- One row per canonical benchmark within a session.
-- measurements is a JSONB blob whose schema is defined in API_CONTRACTS.md §7.
-- CX-ARCH-2: aggregate_name is a per-measurement-row field inside measurements,
--            NOT a case-level column.
CREATE TABLE benchmark_cases (
    case_id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID  NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    project_name    TEXT  NOT NULL,
    canonical_name  TEXT  NOT NULL,
    data_type       TEXT  NOT NULL
                        CHECK (data_type IN (
                            'raw_samples_available',
                            'aggregate_only',
                            'no_measurements'
                        )),
    measurements    JSONB NOT NULL,
    UNIQUE (session_id, project_name, canonical_name)
);

-- ── comparisons ───────────────────────────────────────────────────────────────
-- One row per computed comparison result.  result is a JSONB blob.
CREATE TABLE comparisons (
    comparison_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_a_id    UUID        NOT NULL REFERENCES sessions(session_id),
    session_b_id    UUID        NOT NULL REFERENCES sessions(session_id),
    result          JSONB       NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Provenance immutability trigger (CX-S-2) ─────────────────────────────────
-- Prevents UPDATE of source, source_marker, and import_timestamp on sessions.
-- Applied to `sessions` table (not `runs` — CX-S-2 corrects the SECURITY.md §13.2
-- typo; the original doc said `runs`, which does not exist in this schema).
CREATE OR REPLACE FUNCTION prevent_provenance_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.source IS DISTINCT FROM OLD.source OR
       NEW.source_marker IS DISTINCT FROM OLD.source_marker OR
       NEW.import_timestamp IS DISTINCT FROM OLD.import_timestamp THEN
        RAISE EXCEPTION
            'provenance fields (source, source_marker, import_timestamp) are immutable after insert';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_provenance_immutability
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION prevent_provenance_update();

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX idx_sessions_device_id         ON sessions(device_id);
CREATE INDEX idx_sessions_import_timestamp  ON sessions(import_timestamp DESC);
CREATE INDEX idx_sessions_source            ON sessions(source);
CREATE INDEX idx_benchmark_cases_session_id ON benchmark_cases(session_id);
CREATE INDEX idx_comparisons_session_a      ON comparisons(session_a_id);
CREATE INDEX idx_comparisons_session_b      ON comparisons(session_b_id);

-- ── Application account grants (CX-S-4) ───────────────────────────────────────
-- Narrowed from the original SECURITY.md §12.3 draft (which incorrectly granted
-- SELECT, INSERT, UPDATE, DELETE ON ALL TABLES).
-- ARCHITECTURE.md §6.1 is authoritative: SELECT + INSERT on all tables,
-- plus UPDATE limited to api_key_hash only.
-- No DELETE is granted to sscope_app.
GRANT SELECT, INSERT ON devices, sessions, benchmark_cases, comparisons TO sscope_app;
GRANT UPDATE (api_key_hash) ON devices TO sscope_app;

COMMIT;

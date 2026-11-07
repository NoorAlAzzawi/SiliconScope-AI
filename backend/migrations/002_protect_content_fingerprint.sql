-- Migration: 002_protect_content_fingerprint.sql
--
-- Extends the provenance immutability trigger to also protect content_fingerprint.
--
-- Rationale: content_fingerprint is the SHA-256 / JCS integrity anchor for all
-- benchmark data.  Allowing a post-insert UPDATE would let an attacker with
-- database access tamper with benchmark_cases rows, recompute a matching hash,
-- and silently update content_fingerprint — voiding the entire integrity guarantee.
-- sscope_app holds only SELECT+INSERT on sessions, so the application layer is
-- already clean.  This migration closes the gap for sscope_migrations and
-- superuser accounts.
--
-- Changes: CREATE OR REPLACE FUNCTION prevent_provenance_update() — adds
-- content_fingerprint to the existing three-column immutability check.
-- The trigger binding (enforce_provenance_immutability) is unchanged.
-- No schema changes, no data migration, no risk to existing rows.

BEGIN;

CREATE OR REPLACE FUNCTION prevent_provenance_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.source IS DISTINCT FROM OLD.source OR
       NEW.source_marker IS DISTINCT FROM OLD.source_marker OR
       NEW.import_timestamp IS DISTINCT FROM OLD.import_timestamp OR
       NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint THEN
        RAISE EXCEPTION
            'provenance fields (source, source_marker, import_timestamp, content_fingerprint) are immutable after insert';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

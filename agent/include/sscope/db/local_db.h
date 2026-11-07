#pragma once
#include <optional>
#include <string>
#include <vector>

// Forward-declare sqlite3 to keep the header clean.
struct sqlite3;

namespace sscope {

// ── Per-session metadata ─────────────────────────────────────────────────────
struct SessionRow {
    std::string session_id;           // UUID v4
    std::string run_name;
    std::string os_name;
    std::string os_version;
    std::string cpu_name;
    std::string isa;
    std::string build_type;
    std::string source;               // "synthetic" | "user-supplied import"
    std::optional<std::string> source_marker;
    std::optional<std::string> git_sha;
    std::optional<std::string> build_config;
    std::string import_timestamp;     // YYYY-MM-DDTHH:mm:ssZ
    std::optional<std::string> import_environment;  // null for synthetic
    std::string content_fingerprint;  // 64 lowercase hex chars
    std::string sync_status;          // "pending" | "synced" | "conflict"
    std::optional<std::string> sync_reason;
    std::string submitted_at;         // ISO 8601 UTC
};

// ── Per-case row ─────────────────────────────────────────────────────────────
struct BenchmarkCaseRow {
    std::string case_id;              // UUID v4
    std::string session_id;
    std::string project_name;
    std::string canonical_name;
    std::string data_type;            // "raw_samples_available" | "aggregate_only" | "no_measurements"
    std::string measurements_json;    // JSON blob per API_CONTRACTS.md §7
};

// ── LocalDb ──────────────────────────────────────────────────────────────────
// Wraps the SQLite database at ~/.config/sscope/local.db.
// - WAL mode and foreign-key enforcement enabled on every open.
// - Schema is created (CREATE TABLE IF NOT EXISTS) on first open.
// - All public methods throw std::runtime_error on SQLite errors.
class LocalDb {
public:
    // Open (or create) the database.  Creates ~/.config/sscope/ if needed.
    // Throws on error.
    explicit LocalDb(const std::string& path = "");
    ~LocalDb();

    LocalDb(const LocalDb&) = delete;
    LocalDb& operator=(const LocalDb&) = delete;

    // Insert a session row.  Does NOT insert benchmark_cases.
    // Throws if session_id already exists.
    void insert_session(const SessionRow& row);

    // Insert one benchmark_case row.
    // Throws if the (session_id, project_name, canonical_name) triple already exists.
    void insert_benchmark_case(const BenchmarkCaseRow& row);

    // Retrieve a session by session_id. Returns nullopt if not found.
    std::optional<SessionRow> get_session(const std::string& session_id);

    // List all sessions ordered by submitted_at DESC.
    std::vector<SessionRow> list_sessions();

    // Return all sessions with sync_status = 'pending', ordered by submitted_at ASC.
    std::vector<SessionRow> get_pending_sessions();

    // Return all benchmark cases for a given session_id, ordered by project_name, canonical_name.
    std::vector<BenchmarkCaseRow> get_benchmark_cases(const std::string& session_id);

    // Update the sync_status (and optional sync_reason) for a session.
    // Allowed transitions: pending → synced | conflict.
    void update_sync_status(const std::string& session_id,
                            const std::string& status,
                            const std::optional<std::string>& reason = std::nullopt);

    // Return the default database path: ~/.config/sscope/local.db
    static std::string default_path();

    // Begin / commit / rollback a transaction.
    // Use exec_transaction to run a callable atomically:
    //   db.begin(); ... db.commit(); / db.rollback();
    void begin();
    void commit();
    void rollback();

private:
    sqlite3* db_ = nullptr;

    void apply_pragmas();
    void create_schema();
    void exec(const std::string& sql);
};

} // namespace sscope

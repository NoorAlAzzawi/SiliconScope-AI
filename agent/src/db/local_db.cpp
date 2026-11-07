#include "sscope/db/local_db.h"

#include <sqlite3.h>

#include <filesystem>
#include <stdexcept>
#include <string>
#include <sys/stat.h>

namespace sscope {

// ── Schema DDL ───────────────────────────────────────────────────────────────
// Schema per ARCHITECTURE.md §6.2 + planning notes:
//   - Missing comma after sync_reason TEXT corrected here.
//   - SQLite uses TEXT for all fields; UUIDs are TEXT strings.
static constexpr const char* SCHEMA_DDL = R"sql(
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  run_name            TEXT NOT NULL,
  os_name             TEXT NOT NULL,
  os_version          TEXT NOT NULL,
  cpu_name            TEXT NOT NULL,
  isa                 TEXT NOT NULL,
  build_type          TEXT NOT NULL,
  source              TEXT NOT NULL
                          CHECK (source IN ('synthetic', 'user-supplied import')),
  source_marker       TEXT,
  git_sha             TEXT,
  build_config        TEXT,
  import_timestamp    TEXT NOT NULL,
  import_environment  TEXT,
  content_fingerprint TEXT NOT NULL,
  sync_status         TEXT NOT NULL DEFAULT 'pending'
                          CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  sync_reason         TEXT,
  submitted_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_cases (
  case_id         TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  project_name    TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  data_type       TEXT NOT NULL
                      CHECK (data_type IN (
                        'raw_samples_available',
                        'aggregate_only',
                        'no_measurements'
                      )),
  measurements    TEXT NOT NULL,
  UNIQUE (session_id, project_name, canonical_name)
);
)sql";

// ── Helpers ──────────────────────────────────────────────────────────────────

static std::string opt_str(sqlite3_stmt* stmt, int col) {
    if (sqlite3_column_type(stmt, col) == SQLITE_NULL) return "";
    const unsigned char* t = sqlite3_column_text(stmt, col);
    return t ? reinterpret_cast<const char*>(t) : "";
}

static std::optional<std::string> opt_nullable(sqlite3_stmt* stmt, int col) {
    if (sqlite3_column_type(stmt, col) == SQLITE_NULL) return std::nullopt;
    const unsigned char* t = sqlite3_column_text(stmt, col);
    return t ? std::optional<std::string>(reinterpret_cast<const char*>(t)) : std::nullopt;
}

// ── LocalDb ──────────────────────────────────────────────────────────────────

std::string LocalDb::default_path() {
    const char* home = std::getenv("HOME");
    std::string base = home ? std::string(home) : "/tmp";
    return base + "/.config/sscope/local.db";
}

LocalDb::LocalDb(const std::string& path) {
    std::string db_path = path.empty() ? default_path() : path;

    // Ensure the parent directory exists and is mode 0700 (ST-19).
    auto parent = std::filesystem::path(db_path).parent_path();
    std::filesystem::create_directories(parent);
    // Apply 0700 on every open — covers both first-create and pre-existing dirs.
    chmod(parent.c_str(), 0700);

    int rc = sqlite3_open(db_path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        std::string err = sqlite3_errmsg(db_);
        sqlite3_close(db_);
        db_ = nullptr;
        throw std::runtime_error("LocalDb: sqlite3_open failed: " + err);
    }

    apply_pragmas();
    create_schema();

    // ST-19: enforce 0600 on the DB file after every open.
    chmod(db_path.c_str(), 0600);
}

LocalDb::~LocalDb() {
    if (db_) {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

void LocalDb::exec(const std::string& sql) {
    char* errmsg = nullptr;
    int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &errmsg);
    if (rc != SQLITE_OK) {
        std::string msg = errmsg ? errmsg : "unknown error";
        sqlite3_free(errmsg);
        throw std::runtime_error("LocalDb: SQL error: " + msg);
    }
}

void LocalDb::apply_pragmas() {
    exec("PRAGMA journal_mode=WAL;");
    exec("PRAGMA foreign_keys=ON;");
}

void LocalDb::create_schema() {
    exec(SCHEMA_DDL);
}

void LocalDb::insert_session(const SessionRow& r) {
    static const char* SQL = R"sql(
        INSERT INTO sessions (
            session_id, run_name, os_name, os_version, cpu_name, isa,
            build_type, source, source_marker, git_sha, build_config,
            import_timestamp, import_environment, content_fingerprint,
            sync_status, sync_reason, submitted_at
        ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        )
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare insert_session: "
                                 + std::string(sqlite3_errmsg(db_)));

    auto bind_text = [&](int col, const std::string& v) {
        sqlite3_bind_text(stmt, col, v.c_str(), -1, SQLITE_TRANSIENT);
    };
    auto bind_opt = [&](int col, const std::optional<std::string>& v) {
        if (v) sqlite3_bind_text(stmt, col, v->c_str(), -1, SQLITE_TRANSIENT);
        else   sqlite3_bind_null(stmt, col);
    };

    bind_text(1,  r.session_id);
    bind_text(2,  r.run_name);
    bind_text(3,  r.os_name);
    bind_text(4,  r.os_version);
    bind_text(5,  r.cpu_name);
    bind_text(6,  r.isa);
    bind_text(7,  r.build_type);
    bind_text(8,  r.source);
    bind_opt (9,  r.source_marker);
    bind_opt (10, r.git_sha);
    bind_opt (11, r.build_config);
    bind_text(12, r.import_timestamp);
    bind_opt (13, r.import_environment);
    bind_text(14, r.content_fingerprint);
    bind_text(15, r.sync_status);
    bind_opt (16, r.sync_reason);
    bind_text(17, r.submitted_at);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE)
        throw std::runtime_error("LocalDb: insert_session failed: "
                                 + std::string(sqlite3_errmsg(db_)));
}

void LocalDb::insert_benchmark_case(const BenchmarkCaseRow& r) {
    static const char* SQL = R"sql(
        INSERT INTO benchmark_cases (
            case_id, session_id, project_name, canonical_name, data_type, measurements
        ) VALUES (?,?,?,?,?,?)
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare insert_benchmark_case: "
                                 + std::string(sqlite3_errmsg(db_)));

    auto bind_text = [&](int col, const std::string& v) {
        sqlite3_bind_text(stmt, col, v.c_str(), -1, SQLITE_TRANSIENT);
    };

    bind_text(1, r.case_id);
    bind_text(2, r.session_id);
    bind_text(3, r.project_name);
    bind_text(4, r.canonical_name);
    bind_text(5, r.data_type);
    bind_text(6, r.measurements_json);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE)
        throw std::runtime_error("LocalDb: insert_benchmark_case failed: "
                                 + std::string(sqlite3_errmsg(db_)));
}

static SessionRow row_from_stmt(sqlite3_stmt* stmt) {
    SessionRow r;
    r.session_id          = opt_str(stmt, 0);
    r.run_name            = opt_str(stmt, 1);
    r.os_name             = opt_str(stmt, 2);
    r.os_version          = opt_str(stmt, 3);
    r.cpu_name            = opt_str(stmt, 4);
    r.isa                 = opt_str(stmt, 5);
    r.build_type          = opt_str(stmt, 6);
    r.source              = opt_str(stmt, 7);
    r.source_marker       = opt_nullable(stmt, 8);
    r.git_sha             = opt_nullable(stmt, 9);
    r.build_config        = opt_nullable(stmt, 10);
    r.import_timestamp    = opt_str(stmt, 11);
    r.import_environment  = opt_nullable(stmt, 12);
    r.content_fingerprint = opt_str(stmt, 13);
    r.sync_status         = opt_str(stmt, 14);
    r.sync_reason         = opt_nullable(stmt, 15);
    r.submitted_at        = opt_str(stmt, 16);
    return r;
}

std::optional<SessionRow> LocalDb::get_session(const std::string& session_id) {
    static const char* SQL = R"sql(
        SELECT session_id, run_name, os_name, os_version, cpu_name, isa,
               build_type, source, source_marker, git_sha, build_config,
               import_timestamp, import_environment, content_fingerprint,
               sync_status, sync_reason, submitted_at
        FROM sessions WHERE session_id = ?
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare get_session: "
                                 + std::string(sqlite3_errmsg(db_)));

    sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);

    std::optional<SessionRow> result;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        result = row_from_stmt(stmt);
    sqlite3_finalize(stmt);
    return result;
}

std::vector<SessionRow> LocalDb::list_sessions() {
    static const char* SQL = R"sql(
        SELECT session_id, run_name, os_name, os_version, cpu_name, isa,
               build_type, source, source_marker, git_sha, build_config,
               import_timestamp, import_environment, content_fingerprint,
               sync_status, sync_reason, submitted_at
        FROM sessions ORDER BY submitted_at DESC
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare list_sessions: "
                                 + std::string(sqlite3_errmsg(db_)));

    std::vector<SessionRow> rows;
    while (sqlite3_step(stmt) == SQLITE_ROW)
        rows.push_back(row_from_stmt(stmt));
    sqlite3_finalize(stmt);
    return rows;
}

std::vector<SessionRow> LocalDb::get_pending_sessions() {
    static const char* SQL = R"sql(
        SELECT session_id, run_name, os_name, os_version, cpu_name, isa,
               build_type, source, source_marker, git_sha, build_config,
               import_timestamp, import_environment, content_fingerprint,
               sync_status, sync_reason, submitted_at
        FROM sessions WHERE sync_status = 'pending' ORDER BY submitted_at ASC
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare get_pending_sessions: "
                                 + std::string(sqlite3_errmsg(db_)));

    std::vector<SessionRow> rows;
    while (sqlite3_step(stmt) == SQLITE_ROW)
        rows.push_back(row_from_stmt(stmt));
    sqlite3_finalize(stmt);
    return rows;
}

std::vector<BenchmarkCaseRow> LocalDb::get_benchmark_cases(const std::string& session_id) {
    static const char* SQL = R"sql(
        SELECT case_id, session_id, project_name, canonical_name, data_type, measurements
        FROM benchmark_cases WHERE session_id = ?
        ORDER BY project_name, canonical_name
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare get_benchmark_cases: "
                                 + std::string(sqlite3_errmsg(db_)));

    sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);

    std::vector<BenchmarkCaseRow> rows;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        BenchmarkCaseRow r;
        r.case_id           = opt_str(stmt, 0);
        r.session_id        = opt_str(stmt, 1);
        r.project_name      = opt_str(stmt, 2);
        r.canonical_name    = opt_str(stmt, 3);
        r.data_type         = opt_str(stmt, 4);
        r.measurements_json = opt_str(stmt, 5);
        rows.push_back(r);
    }
    sqlite3_finalize(stmt);
    return rows;
}

void LocalDb::begin()    { exec("BEGIN"); }
void LocalDb::commit()   { exec("COMMIT"); }
void LocalDb::rollback() { exec("ROLLBACK"); }

void LocalDb::update_sync_status(const std::string& session_id,
                                  const std::string& status,
                                  const std::optional<std::string>& reason) {
    static const char* SQL = R"sql(
        UPDATE sessions SET sync_status = ?, sync_reason = ? WHERE session_id = ?
    )sql";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, SQL, -1, &stmt, nullptr) != SQLITE_OK)
        throw std::runtime_error("LocalDb: prepare update_sync_status: "
                                 + std::string(sqlite3_errmsg(db_)));

    sqlite3_bind_text(stmt, 1, status.c_str(), -1, SQLITE_TRANSIENT);
    if (reason)
        sqlite3_bind_text(stmt, 2, reason->c_str(), -1, SQLITE_TRANSIENT);
    else
        sqlite3_bind_null(stmt, 2);
    sqlite3_bind_text(stmt, 3, session_id.c_str(), -1, SQLITE_TRANSIENT);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE)
        throw std::runtime_error("LocalDb: update_sync_status failed: "
                                 + std::string(sqlite3_errmsg(db_)));
}

} // namespace sscope

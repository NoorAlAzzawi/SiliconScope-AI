#include "sscope/import/benchmark_importer.h"
#include "sscope/import/benchmark_sort.h"

#include "sscope/db/local_db.h"
#include "sscope/fingerprint/fingerprint.h"
#include "sscope/platform/platform_adapter.h"
#include "sscope/sync/sync_client.h"

#include <nlohmann/json.hpp>

#include <cerrno>
#include <chrono>
#include <iostream>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace sscope {

using json = nlohmann::json;

static constexpr size_t MAX_FILE_BYTES    = 50 * 1024 * 1024; // 50 MiB
static constexpr int    MAX_BENCHMARK_ROWS = 10000;
static constexpr int    MAX_NAME_BYTES     = 1024;
static constexpr int    JSON_MAX_DEPTH     = 33;

// ── Helpers ──────────────────────────────────────────────────────────────────

static bool is_valid_utf8(const std::string& s) {
    const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = p[i];
        int bytes;
        if (c < 0x80) { bytes = 1; }
        else if ((c & 0xE0) == 0xC0) { bytes = 2; }
        else if ((c & 0xF0) == 0xE0) { bytes = 3; }
        else if ((c & 0xF8) == 0xF0) { bytes = 4; }
        else return false;
        for (int b = 1; b < bytes; ++b) {
            if (i + b >= n) return false;
            if ((p[i + b] & 0xC0) != 0x80) return false;
        }
        i += bytes;
    }
    return true;
}

static bool has_control_chars(const std::string& s) {
    for (unsigned char c : s)
        if (c < 0x20 || c == 0x7F) return true;  // U+0000–U+001F and U+007F (DEL)
    return false;
}

// Generate a UUID v4 string.
static std::string gen_uuid_v4() {
    std::random_device rd;
    std::mt19937_64 gen(rd());
    std::uniform_int_distribution<uint64_t> dist;
    uint64_t hi = dist(gen);
    uint64_t lo = dist(gen);
    // Set version 4 bits.
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
    // Set variant bits.
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;
    std::ostringstream oss;
    oss << std::hex << std::setfill('0')
        << std::setw(8) << (hi >> 32)
        << '-' << std::setw(4) << ((hi >> 16) & 0xFFFF)
        << '-' << std::setw(4) << (hi & 0xFFFF)
        << '-' << std::setw(4) << (lo >> 48)
        << '-' << std::setw(12) << (lo & 0x0000FFFFFFFFFFFFULL);
    return oss.str();
}

// Current UTC timestamp in ISO 8601 format.
static std::string utc_now_iso8601() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm_val{};
    gmtime_r(&t, &tm_val);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm_val);
    return buf;
}

// Validate a single benchmark row for required fields and value ranges.
// Throws ImportValidationError(4, ...) on failure.
static void validate_row(const json& row, int row_idx) {
    auto err4 = [&](const std::string& msg) {
        throw ImportValidationError(4, "row " + std::to_string(row_idx) + ": " + msg);
    };

    if (!row.contains("name") || !row["name"].is_string())
        err4("missing or non-string 'name'");

    const std::string name = row["name"].get<std::string>();
    if (name.empty())
        err4("'name' is empty");
    if (static_cast<int>(name.size()) > MAX_NAME_BYTES)
        err4("'name' exceeds " + std::to_string(MAX_NAME_BYTES) + " bytes");
    if (!is_valid_utf8(name))
        err4("'name' contains invalid UTF-8");
    if (has_control_chars(name))
        err4("'name' contains control characters");

    // real_time is required.
    if (!row.contains("real_time") || !row["real_time"].is_number())
        err4("missing or non-numeric 'real_time'");
    double rt = row["real_time"].get<double>();
    if (rt < 0.0)
        err4("'real_time' is negative");

    // time_unit is required.
    if (!row.contains("time_unit") || !row["time_unit"].is_string())
        err4("missing or non-string 'time_unit'");
    const std::string tu = row["time_unit"].get<std::string>();
    if (tu != "ns" && tu != "us" && tu != "ms" && tu != "s")
        err4("unknown 'time_unit': " + tu);
}

// Classify a row as "iteration" (raw), "aggregate", or "unsupported".
static std::string classify_row(const json& row) {
    if (row.contains("run_type") && row["run_type"].is_string()) {
        const std::string rt = row["run_type"].get<std::string>();
        if (rt == "iteration") return "iteration";
        if (rt == "aggregate") return "aggregate";
        return "unsupported";
    }
    // Old Google Benchmark output: run_type absent.
    // Per BENCHMARK_SPEC.md §9.4 Step 3: aggregate_name present → aggregate.
    if (row.contains("aggregate_name") && row["aggregate_name"].is_string())
        return "aggregate";
    return "iteration";
}

// Convert time to nanoseconds based on time_unit.
static double to_nanoseconds(double val, const std::string& unit) {
    if (unit == "ns") return val;
    if (unit == "us") return val * 1e3;
    if (unit == "ms") return val * 1e6;
    if (unit == "s")  return val * 1e9;
    return val; // unreachable after stage-4 validation
}

// Build one measurement JSON object from a row.
// All 5 optional fields are explicit null when absent (per spec Stage 9).
static json build_measurement(const json& row) {
    const std::string unit = row["time_unit"].get<std::string>();
    double real_ns  = to_nanoseconds(row["real_time"].get<double>(), unit);

    json m = json::object();
    m["real_time_ns"] = real_ns;

    // cpu_time is optional.
    if (row.contains("cpu_time") && row["cpu_time"].is_number())
        m["cpu_time_ns"] = to_nanoseconds(row["cpu_time"].get<double>(), unit);
    else
        m["cpu_time_ns"] = nullptr;

    // iterations is optional but usually present for raw rows.
    if (row.contains("iterations") && row["iterations"].is_number_integer())
        m["iterations"] = row["iterations"].get<int64_t>();
    else
        m["iterations"] = nullptr;

    // aggregate_name present only for aggregate rows.
    if (row.contains("aggregate_name") && row["aggregate_name"].is_string())
        m["aggregate_name"] = row["aggregate_name"].get<std::string>();
    else
        m["aggregate_name"] = nullptr;

    // bytes_per_second is optional.
    if (row.contains("bytes_per_second") && row["bytes_per_second"].is_number())
        m["bytes_per_second"] = row["bytes_per_second"].get<double>();
    else
        m["bytes_per_second"] = nullptr;

    // items_per_second is optional.
    if (row.contains("items_per_second") && row["items_per_second"].is_number())
        m["items_per_second"] = row["items_per_second"].get<double>();
    else
        m["items_per_second"] = nullptr;

    // unknown_fields: collect any non-standard keys present in the row.
    // Security: these are stored as JSON, never interpreted as commands.
    static const std::set<std::string> KNOWN_KEYS = {
        "name", "run_name", "run_type", "repetitions", "repetition_index",
        "threads", "real_time", "cpu_time", "time_unit", "iterations",
        "bytes_per_second", "items_per_second", "label", "error_occurred",
        "error_message", "aggregate_name"
    };
    json unknown = json::object();
    for (auto& [k, v] : row.items()) {
        if (KNOWN_KEYS.find(k) == KNOWN_KEYS.end())
            unknown[k] = v;
    }
    m["unknown_fields"] = unknown.empty() ? json(nullptr) : unknown;

    return m;
}

// ── BenchmarkImporter ────────────────────────────────────────────────────────

BenchmarkImporter::BenchmarkImporter(LocalDb& db,
                                     const std::string& server_url,
                                     const std::string& api_key)
    : db_(db), server_url_(server_url), api_key_(api_key) {}

ImportResult BenchmarkImporter::import(const std::string& path, const ImportOptions& opts) {

    // ── Stage 0: File existence ───────────────────────────────────────────────
    if (access(path.c_str(), F_OK) != 0) {
        if (errno == ENOENT)
            throw ImportFileNotFound(path);
        throw ImportValidationError(0, "cannot access file: " + std::string(strerror(errno)));
    }

    // ── Stage 1: File size ────────────────────────────────────────────────────
    struct stat st{};
    if (stat(path.c_str(), &st) != 0)
        throw ImportValidationError(1, "stat failed: " + std::string(strerror(errno)));
    if (static_cast<size_t>(st.st_size) > MAX_FILE_BYTES)
        throw ImportValidationError(1, "file exceeds 50 MiB limit");

    // Read file content — TOCTOU mitigation: check size while reading.
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs.is_open())
        throw ImportValidationError(1, "cannot open file");

    std::string content;
    content.reserve(static_cast<size_t>(st.st_size) + 1);
    {
        char buf[65536];
        size_t total = 0;
        while (ifs.read(buf, sizeof(buf)) || ifs.gcount() > 0) {
            total += static_cast<size_t>(ifs.gcount());
            if (total > MAX_FILE_BYTES)
                throw ImportValidationError(1, "file exceeds 50 MiB limit (TOCTOU)");
            content.append(buf, static_cast<size_t>(ifs.gcount()));
        }
    }

    // ── Stage 2: JSON parse ───────────────────────────────────────────────────
    // Pre-scan for nesting depth BEFORE invoking nlohmann: without this, a
    // deeply-nested document recurses until the call stack overflows (crash, not
    // a controlled rejection).  The scan handles string escapes correctly.
    {
        int depth = 0;
        bool in_string = false;
        for (size_t i = 0; i < content.size(); ++i) {
            char c = content[i];
            if (in_string) {
                if (c == '\\') { ++i; continue; }  // skip escaped character
                if (c == '"')  { in_string = false; }
            } else {
                if (c == '"') { in_string = true; continue; }
                if (c == '{' || c == '[') {
                    if (++depth > JSON_MAX_DEPTH)
                        throw ImportValidationError(2,
                            "JSON nesting depth exceeds limit of "
                            + std::to_string(JSON_MAX_DEPTH));
                } else if (c == '}' || c == ']') {
                    if (depth > 0) --depth;
                }
            }
        }
    }

    json doc;
    try {
        doc = json::parse(content, nullptr, /*allow_exceptions=*/true,
                          /*ignore_comments=*/false);
    } catch (const json::parse_error& e) {
        throw ImportValidationError(2, std::string("JSON parse error: ") + e.what());
    }
    if (doc.is_discarded())
        throw ImportValidationError(2, "JSON parse returned discarded value");

    // ── Stage 3: Top-level schema ─────────────────────────────────────────────
    if (!doc.is_object())
        throw ImportValidationError(3, "top-level value is not a JSON object");

    if (!doc.contains("context") || !doc["context"].is_object())
        throw ImportValidationError(3, "missing or non-object 'context' field");

    if (!doc.contains("benchmarks") || !doc["benchmarks"].is_array())
        throw ImportValidationError(3, "missing or non-array 'benchmarks' field");

    const json& benchmarks = doc["benchmarks"];
    if (static_cast<int>(benchmarks.size()) > MAX_BENCHMARK_ROWS)
        throw ImportValidationError(3, "benchmarks array exceeds " +
                                    std::to_string(MAX_BENCHMARK_ROWS) + " rows");

    // ── Stage 4 + 5: Per-row validation and classification ────────────────────
    // Each row is validated before any grouping occurs.
    struct RowData {
        std::string name;
        std::string classification; // "iteration", "aggregate", "unsupported"
        json measurement;
    };

    std::vector<RowData> rows;
    rows.reserve(benchmarks.size());
    int row_idx = 0;
    for (const json& row : benchmarks) {
        if (!row.is_object())
            throw ImportValidationError(4, "row " + std::to_string(row_idx) +
                                        " is not a JSON object");
        validate_row(row, row_idx);

        std::string classification = classify_row(row);
        if (classification == "unsupported") {
            // Stage 5: unsupported rows are skipped silently.
            ++row_idx;
            continue;
        }

        rows.push_back({
            row["name"].get<std::string>(),
            classification,
            build_measurement(row)
        });
        ++row_idx;
    }

    // ── Stage 6 + 7: Grouping, canonical name, duplicate detection ───────────
    // Canonical name = benchmark name as-is (no suffix stripping).
    // Each unique name → one BenchmarkCase.
    // Rows with the same name are grouped together:
    //   run_type=="iteration" → raw_rows
    //   run_type=="aggregate" → aggregate_rows

    struct CaseData {
        std::string canonical_name;
        json raw_rows        = json::array();
        json aggregate_rows  = json::array();
    };

    // Ordered map: canonical_name → index in cases vector.
    std::vector<CaseData> cases;
    std::vector<std::string> case_order; // insertion order
    for (auto& r : rows) {
        auto it = std::find(case_order.begin(), case_order.end(), r.name);
        if (it == case_order.end()) {
            case_order.push_back(r.name);
            cases.push_back({r.name, json::array(), json::array()});
            it = case_order.end() - 1;
        }
        size_t idx = static_cast<size_t>(it - case_order.begin());
        if (r.classification == "iteration")
            cases[idx].raw_rows.push_back(r.measurement);
        else
            cases[idx].aggregate_rows.push_back(r.measurement);
    }

    // Stage 7: no two cases in this batch share the same canonical_name
    // (already guaranteed by the grouping above — case_order has no duplicates).

    // ── Stage 8: data_type label ──────────────────────────────────────────────
    // raw_samples_available: has raw rows
    // aggregate_only:        no raw rows, has aggregate rows
    // no_measurements:       neither
    auto data_type_for = [](const CaseData& c) -> std::string {
        if (!c.raw_rows.empty()) return "raw_samples_available";
        if (!c.aggregate_rows.empty()) return "aggregate_only";
        return "no_measurements";
    };

    // ── Stage 9: measurements JSON blob ──────────────────────────────────────
    // measurements = {"raw_rows": [...], "aggregate_rows": [...]}
    // Already built above.

    // ── Stage 10: Import-time environment capture ─────────────────────────────
    auto adapter = make_platform_adapter();
    PlatformInfo env = adapter->gather();

    json import_env = json::object();
    import_env["cpu_name"]       = env.cpu_name;
    import_env["isa"]            = env.isa;
    import_env["os_name"]        = env.os_name;
    import_env["os_version"]     = env.os_version;
    import_env["physical_cores"] = env.physical_cores;
    import_env["logical_cores"]  = env.logical_cores;
    import_env["base_freq_mhz"]  = env.base_freq_mhz;
    import_env["total_mem_bytes"]= env.total_mem_bytes;

    // Extract context metadata for session fields.
    const json& ctx = doc["context"];
    std::string run_name    = ctx.contains("executable") && ctx["executable"].is_string()
                                ? ctx["executable"].get<std::string>()
                                : path;
    std::string build_type  = ctx.contains("build_type") && ctx["build_type"].is_string()
                                ? ctx["build_type"].get<std::string>()
                                : "unknown";
    std::optional<std::string> git_sha;
    if (opts.git_sha.has_value()) {
        git_sha = opts.git_sha;
    } else if (ctx.contains("git_sha") && ctx["git_sha"].is_string()) {
        git_sha = ctx["git_sha"].get<std::string>();
    }

    // ── Stage 11: UUID v4 generation ─────────────────────────────────────────
    const std::string session_id = gen_uuid_v4();
    const std::string ts         = utc_now_iso8601();

    // ── Stage 12: Fingerprint computation ────────────────────────────────────
    // Derive source and marker once; used in stages 12, 13, and 14.
    const std::string src    = opts.source_override.value_or("user-supplied import");
    const std::string marker = (src == "synthetic") ? "sscope-builtin" : path;

    // Build the canonical object F per API_CONTRACTS.md §5.3.
    // All nullable fields appear explicitly (never omitted).
    json F = json::object();
    F["v"]                  = 1;
    F["run_name"]           = run_name;
    F["os_name"]            = env.os_name;
    F["os_version"]         = env.os_version;
    F["cpu_name"]           = env.cpu_name;
    F["isa"]                = env.isa;
    F["build_type"]         = build_type;
    F["source"]             = src;
    F["source_marker"]      = marker;
    F["git_sha"]            = git_sha.has_value() ? json(*git_sha) : json(nullptr);
    F["build_config"]       = opts.build_config.has_value() ? json(opts.build_config.value()) : json(nullptr);
    F["import_timestamp"]   = ts;
    F["import_environment"] = import_env;

    // Build sorted cases array for F.
    json F_cases = json::array();
    for (const auto& c : cases) {
        json measurements = json::object();
        measurements["raw_rows"]       = c.raw_rows;
        measurements["aggregate_rows"] = c.aggregate_rows;

        json fc = json::object();
        fc["canonical_name"] = c.canonical_name;
        fc["data_type"]      = data_type_for(c);
        fc["measurements"]   = measurements;
        fc["project_name"]   = "default";
        F_cases.push_back(fc);
    }
    // Sort by project_name + NUL + canonical_name per API_CONTRACTS.md §5.3.
    std::sort(F_cases.begin(), F_cases.end(), sscope::detail::benchmark_case_less);
    F["cases"] = F_cases;

    const std::string fingerprint = jcs_sha256_hex(F);

    // ── Stage 13: SQLite atomic transaction write ─────────────────────────────
    // Build SessionRow.
    SessionRow session;
    session.session_id          = session_id;
    session.run_name            = run_name;
    session.os_name             = env.os_name;
    session.os_version          = env.os_version;
    session.cpu_name            = env.cpu_name;
    session.isa                 = env.isa;
    session.build_type          = build_type;
    session.source              = src;
    session.source_marker       = marker;
    session.git_sha             = git_sha;
    session.build_config        = opts.build_config;
    session.import_timestamp    = ts;
    session.import_environment  = import_env.dump();
    session.content_fingerprint = fingerprint;
    session.sync_status         = "pending";
    session.sync_reason         = std::nullopt;
    session.submitted_at        = ts;

    // Write session + all cases in a single transaction.
    int cases_written = 0;
    db_.begin();
    try {
        db_.insert_session(session);
        for (const auto& c : cases) {
            BenchmarkCaseRow bc;
            bc.case_id        = gen_uuid_v4();
            bc.session_id     = session_id;
            bc.project_name   = "default";
            bc.canonical_name = c.canonical_name;
            bc.data_type      = data_type_for(c);

            json measurements = json::object();
            measurements["raw_rows"]       = c.raw_rows;
            measurements["aggregate_rows"] = c.aggregate_rows;
            bc.measurements_json = measurements.dump();

            db_.insert_benchmark_case(bc);
            ++cases_written;
        }
        db_.commit();
        // rollback guard ends here — commit succeeded, nothing to roll back.

    } catch (const std::exception& e) {
        db_.rollback();
        throw;
    }

    // ── Stage 14: Sync attempt (best-effort) ─────────────────────────────────
    // Runs OUTSIDE the transaction try/catch so a sync failure cannot trigger
    // db_.rollback() on an already-committed transaction (F-5).
    if (!server_url_.empty()) {
        // Build POST /api/v1/runs body.
        json post_body = json::object();
        post_body["session_id"]            = session_id;
        post_body["run_name"]              = run_name;
        post_body["os_name"]               = env.os_name;
        post_body["os_version"]            = env.os_version;
        post_body["cpu_name"]              = env.cpu_name;
        post_body["isa"]                   = env.isa;
        post_body["build_type"]            = build_type;
        post_body["source"]                = src;
        post_body["source_marker"]         = marker;
        post_body["git_sha"]               = git_sha.has_value() ? json(*git_sha) : json(nullptr);
        post_body["build_config"]          = opts.build_config.has_value() ? json(opts.build_config.value()) : json(nullptr);
        post_body["import_timestamp"]      = ts;
        post_body["import_environment"]    = import_env;
        post_body["submitted_fingerprint"] = fingerprint;

        json benchmarks_arr = json::array();
        for (const auto& c : cases) {
            json bc = json::object();
            bc["project_name"]   = "default";
            bc["canonical_name"] = c.canonical_name;
            bc["data_type"]      = data_type_for(c);
            json meas = json::object();
            meas["raw_rows"]       = c.raw_rows;
            meas["aggregate_rows"] = c.aggregate_rows;
            bc["measurements"]     = meas;
            benchmarks_arr.push_back(bc);
        }
        post_body["benchmarks"] = benchmarks_arr;

        SyncClient sync_client(server_url_, api_key_);
        SyncResult sync_result = sync_client.post_run(post_body.dump());

        if (sync_result.status == SyncStatus::Success) {
            // Parse session_id from backend response body.
            std::string confirmed_session_id = session_id;
            try {
                json resp = json::parse(sync_result.message);
                if (resp.contains("session_id") && resp["session_id"].is_string())
                    confirmed_session_id = resp["session_id"].get<std::string>();
            } catch (...) {}
            std::cout << "Sync complete. Session ID: " << confirmed_session_id << '\n';
            try {
                db_.update_sync_status(session_id, "synced");
            } catch (...) {}
        } else if (sync_result.status == SyncStatus::Conflict) {
            std::cerr << "[sscope] Sync conflict: a session with different content already exists on the server for this run.\n"
                      << "         Local state marked as 'conflict'. Run 'sscope status' or check the dashboard for details.\n";
            try {
                db_.update_sync_status(session_id, "conflict", "session_conflict");
            } catch (...) {}
        } else if (sync_result.status == SyncStatus::AuthError) {
            std::cerr << "[sscope] Synchronization failed: authentication rejected (HTTP "
                      << sync_result.http_code << ").\n"
                      << "         The API key stored in Keychain may have been revoked on the server.\n"
                      << "         Session stored locally. Run 'sscope register' to obtain a new API key.\n"
                      << "         (If the binary was recently rebuilt, allow Keychain access in the"
                         " macOS dialog instead.)\n";
            try {
                db_.update_sync_status(session_id, "pending");
            } catch (...) {}
        } else {
            // Network error or server error: leave as pending for automatic retry.
            std::cerr << "[sscope] Remote synchronization not completed — session stored locally.\n"
                      << "         Will retry automatically on the next successful connection.\n";
            try {
                db_.update_sync_status(session_id, "pending");
            } catch (...) {
                try {
                    db_.update_sync_status(session_id, "conflict", "sync_exception");
                } catch (...) {
                    // Completely best-effort; import already succeeded.
                }
            }
        }
    }

    return {session_id, fingerprint, row_idx, cases_written};
}

} // namespace sscope

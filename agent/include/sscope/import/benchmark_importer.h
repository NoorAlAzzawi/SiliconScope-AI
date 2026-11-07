#pragma once

#include "sscope/db/local_db.h"

#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace sscope {

// Error thrown when the input file is not found (Stage 0).
struct ImportFileNotFound : std::runtime_error {
    explicit ImportFileNotFound(const std::string& path)
        : std::runtime_error("import: file not found: " + path) {}
};

// Error thrown when import fails for any validation reason (Stages 1–12).
// exit_code is 2 (per spec): no writes have occurred.
struct ImportValidationError : std::runtime_error {
    int stage;
    explicit ImportValidationError(int stage, const std::string& msg)
        : std::runtime_error("import stage " + std::to_string(stage) + ": " + msg)
        , stage(stage) {}
};

// Result of a successful import.
struct ImportResult {
    std::string session_id;
    std::string content_fingerprint;
    int total_rows;          // rows parsed from benchmarks array
    int cases_written;       // BenchmarkCaseRows inserted
};

// Options controlling provenance fields for the import pipeline.
struct ImportOptions {
    std::optional<std::string> git_sha;        // overrides JSON context git_sha if set
    std::optional<std::string> build_config;   // whitespace-only already normalized to nullopt by caller
    std::optional<std::string> source_override; // when set, overrides "user-supplied import";
                                                // use "synthetic" for sscope run built-in workloads
};

class BenchmarkImporter {
public:
    // path: filesystem path to a Google Benchmark JSON file.
    // db:   local database to write into.
    // server_url: optional; if non-empty, attempt sync after write.
    // api_key:    optional; used for sync if server_url is set.
    explicit BenchmarkImporter(LocalDb& db,
                               const std::string& server_url = "",
                               const std::string& api_key = "");

    // Run the 14-stage import pipeline.
    // Throws ImportFileNotFound (exit code 1) or ImportValidationError (exit code 2)
    // on failure.  On success, the session and all cases are written atomically.
    ImportResult import(const std::string& path, const ImportOptions& opts = {});

private:
    LocalDb& db_;
    std::string server_url_;
    std::string api_key_;
};

} // namespace sscope

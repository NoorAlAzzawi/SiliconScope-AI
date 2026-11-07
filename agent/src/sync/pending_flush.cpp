#include "sscope/sync/pending_flush.h"

#include <nlohmann/json.hpp>

#include <iostream>
#include <string>
#include <vector>

namespace sscope {

using json = nlohmann::json;

int flush_pending_sessions(LocalDb& db, SyncClient& sync_client) {
    std::vector<SessionRow> pending;
    try {
        pending = db.get_pending_sessions();
    } catch (...) {
        // If we cannot query pending sessions, skip flush silently.
        return 0;
    }

    if (pending.empty())
        return 0;

    int synced_count = 0;

    for (const SessionRow& session : pending) {
        // Load benchmark cases for this session.
        std::vector<BenchmarkCaseRow> cases;
        try {
            cases = db.get_benchmark_cases(session.session_id);
        } catch (...) {
            // Cannot load cases; skip this session silently.
            continue;
        }

        // Reconstruct the POST /api/v1/runs body — same structure as Stage 14
        // in benchmark_importer.cpp.
        json post_body = json::object();
        post_body["session_id"]   = session.session_id;
        post_body["run_name"]     = session.run_name;
        post_body["os_name"]      = session.os_name;
        post_body["os_version"]   = session.os_version;
        post_body["cpu_name"]     = session.cpu_name;
        post_body["isa"]          = session.isa;
        post_body["build_type"]   = session.build_type;
        post_body["source"]       = session.source;

        post_body["source_marker"] = session.source_marker.has_value()
                                     ? json(*session.source_marker)
                                     : json(nullptr);
        post_body["git_sha"]       = session.git_sha.has_value()
                                     ? json(*session.git_sha)
                                     : json(nullptr);
        post_body["build_config"]  = session.build_config.has_value()
                                     ? json(*session.build_config)
                                     : json(nullptr);

        post_body["import_timestamp"]    = session.import_timestamp;
        post_body["submitted_fingerprint"] = session.content_fingerprint;

        // import_environment is stored as a JSON string; parse it back.
        if (session.import_environment.has_value() && !session.import_environment->empty()) {
            try {
                post_body["import_environment"] = json::parse(*session.import_environment);
            } catch (...) {
                post_body["import_environment"] = nullptr;
            }
        } else {
            post_body["import_environment"] = nullptr;
        }

        // Reconstruct benchmark cases array.
        json benchmarks_arr = json::array();
        for (const BenchmarkCaseRow& bc : cases) {
            json bc_obj = json::object();
            bc_obj["project_name"]   = bc.project_name;
            bc_obj["canonical_name"] = bc.canonical_name;
            bc_obj["data_type"]      = bc.data_type;

            // measurements_json is stored as a JSON string; parse it back.
            try {
                bc_obj["measurements"] = json::parse(bc.measurements_json);
            } catch (...) {
                bc_obj["measurements"] = json::object();
            }
            benchmarks_arr.push_back(bc_obj);
        }
        post_body["benchmarks"] = benchmarks_arr;

        // Attempt sync.
        SyncResult result = sync_client.post_run(post_body.dump());

        if (result.status == SyncStatus::Success) {
            std::cout << "[sscope] Retried session " << session.session_id << ": synced.\n";
            try {
                db.update_sync_status(session.session_id, "synced");
            } catch (...) {}
            ++synced_count;
        } else if (result.status == SyncStatus::Conflict) {
            std::cerr << "[sscope] Retried session " << session.session_id
                      << ": conflict — different content already exists on server.\n";
            try {
                db.update_sync_status(session.session_id, "conflict", "session_conflict");
            } catch (...) {}
        } else if (result.status == SyncStatus::AuthError) {
            std::cerr << "[sscope] Pending retry failed: authentication rejected (HTTP "
                      << result.http_code << ").\n"
                      << "         The API key may be missing or revoked. All pending retries"
                         " are suspended.\n"
                      << "         Allow Keychain access in the macOS dialog, or run"
                         " 'sscope register' to obtain a new key.\n";
            // All remaining sessions will also fail auth — stop immediately.
            break;
        } else {
            // Network error or server error: leave as pending, continue with next session.
            std::cerr << "[sscope] Retried session " << session.session_id
                      << ": unreachable, will retry next time.\n";
        }
    }

    return synced_count;
}

} // namespace sscope

#include "sscope/cli_options.h"
#include "sscope/db/local_db.h"
#include "sscope/import/benchmark_importer.h"
#include "sscope/registration/registration.h"
#include "sscope/sync/pending_flush.h"
#include "sscope/sync/sync_client.h"
#include "sscope/workloads/utils.h"
#include "sscope/workloads/workload_json.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <optional>
#include <string>
#include <unistd.h>
#include <vector>

static constexpr const char* SSCOPE_VERSION = "0.1.0";

// Forward declarations for workloads (defined in their respective .cpp files).
namespace sscope {
WorkloadResult run_cpu_integer();
WorkloadResult run_cpu_float();
WorkloadResult run_memory_seq();
WorkloadResult run_memory_rand();
WorkloadResult run_thread_scaling();
} // namespace sscope

// ── Helpers ──────────────────────────────────────────────────────────────────

static void print_usage() {
    std::cerr
        << "usage: sscope <command> [options]\n\n"
        << "commands:\n"
        << "  register             register this device with the backend\n"
        << "  run                  run built-in workloads and store results\n"
        << "  import <file.json>   import a Google Benchmark JSON file\n"
        << "  list                 list stored benchmark sessions\n"
        << "  status               show version, device ID, connectivity, and unsynced count\n"
        << "  compare <a> <b>      compare two benchmark sessions\n\n"
        << "options:\n"
        << "  --backend <url>      backend URL for registration\n"
        << "  --db <path>          path to local SQLite database\n"
        << "                       (default: ~/.config/sscope/local.db)\n"
        << "  --server <url>       backend URL for sync (e.g. http://localhost:3000)\n"
        << "  --api-key <key>      API key for sync authentication\n"
        << "  --commit <sha>       provenance: git commit SHA for this import\n"
        << "  --build-config <cfg> provenance: build configuration label for this import\n"
        << "  --source <src>       filter by source (list only)\n"
        << "  --limit <n>          limit result count (list only)\n"
        << "  --format json        output as JSON (list only)\n"
        << "  --help, -h           show this message\n";
}

using sscope::Options;

static Options parse_args(int argc, char* argv[]) {
    Options opts;
    if (argc < 2) {
        print_usage();
        std::exit(1);
    }
    opts.command = argv[1];
    if (opts.command == "--help" || opts.command == "-h") {
        print_usage();
        std::exit(0);
    }

    int i = 2;
    while (i < argc) {
        std::string arg = argv[i];
        if (arg == "--token") {
            std::cerr << "sscope: --token is not accepted; the registration token is read interactively\n";
            std::exit(1);
        } else if (arg == "--backend" && i + 1 < argc) {
            opts.backend_url = argv[++i];
        } else if (arg == "--db" && i + 1 < argc) {
            opts.db_path = argv[++i];
        } else if (arg == "--server" && i + 1 < argc) {
            opts.server_url = argv[++i];
        } else if (arg == "--api-key" && i + 1 < argc) {
            opts.api_key = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            print_usage();
            std::exit(0);
        } else if (arg == "--commit" && i + 1 < argc) {
            std::string sha = argv[++i];
            if (sha.empty()) {
                std::cerr << "sscope: --commit requires a non-empty value\n";
                std::exit(1);
            }
            opts.commit_sha = sha;
        } else if (arg == "--build-config" && i + 1 < argc) {
            std::string cfg = argv[++i];
            size_t start = cfg.find_first_not_of(" \t\r\n");
            size_t end   = cfg.find_last_not_of(" \t\r\n");
            if (start == std::string::npos)
                opts.build_config_flag = std::nullopt;
            else
                opts.build_config_flag = cfg.substr(start, end - start + 1);
        } else if (arg == "--source" && i + 1 < argc) {
            opts.source_filter = argv[++i];
        } else if (arg == "--limit" && i + 1 < argc) {
            try { opts.limit = std::stoi(argv[++i]); }
            catch (...) { std::cerr << "sscope: --limit requires an integer\n"; std::exit(1); }
        } else if (arg == "--format" && i + 1 < argc) {
            opts.output_format = argv[++i];
        } else if (opts.command == "import" && opts.import_file.empty() && arg[0] != '-') {
            opts.import_file = arg;
        } else if (arg[0] != '-') {
            opts.positional_args.push_back(arg);
        } else {
            std::cerr << "sscope: unknown argument: " << arg << '\n';
            print_usage();
            std::exit(1);
        }
        ++i;
    }
    return opts;
}

// Thin wrapper that calls apply_stored_credentials_impl with the real loaders.
// Keeping them separate allows unit tests to inject mock loaders without
// touching the Keychain.
static Options apply_stored_credentials(Options opts) {
    return sscope::apply_stored_credentials_impl(
        std::move(opts),
        sscope::load_server_url,
        sscope::load_api_key
    );
}

// ── Commands ─────────────────────────────────────────────────────────────────

static int cmd_run(const Options& opts) {
    if (opts.build_config_flag.has_value()) {
        std::cerr << "sscope: --build-config is not supported for 'sscope run'\n";
        return 1;
    }
    sscope::LocalDb db(opts.db_path);

    // §4.3: flush pending sessions before the primary operation if backend is reachable.
    if (!opts.server_url.empty()) {
        sscope::SyncClient sync_client(opts.server_url, opts.api_key);
        auto ps = sync_client.probe();
        if (ps == sscope::ProbeStatus::Reachable) {
            sscope::flush_pending_sessions(db, sync_client);
        } else if (ps == sscope::ProbeStatus::AuthFailed) {
            std::cerr << "[sscope] Warning: backend is reachable but authentication failed.\n"
                      << "         Pending sessions will not be retried until the API key is valid.\n"
                      << "         Allow Keychain access in the macOS dialog, or run"
                         " 'sscope register'.\n";
        }
        // ProbeStatus::Unreachable: continue silently — backend offline is expected.
    }

    sscope::BenchmarkImporter importer(db, opts.server_url, opts.api_key);

    // Run all built-in workloads and collect results.
    // All workloads must succeed before any write occurs to avoid partial sessions.
    struct WorkloadDef {
        const char* name;
        sscope::WorkloadResult (*fn)();
    };

    static const WorkloadDef workloads[] = {
        {"BM_cpu_integer_lcg",   sscope::run_cpu_integer},
        {"BM_cpu_float_trig",    sscope::run_cpu_float},
        {"BM_memory_seq_memcpy", sscope::run_memory_seq},
        {"BM_memory_rand_chase", sscope::run_memory_rand},
        {"BM_thread_scaling",    sscope::run_thread_scaling},
    };

    std::vector<sscope::NamedWorkloadResult> collected;
    int failed = 0;
    for (const auto& w : workloads) {
        std::cerr << "running " << w.name << "...\n";
        try {
            sscope::WorkloadResult result = w.fn();
            std::cout << w.name
                      << "  mean=" << std::fixed << std::setprecision(2)
                      << result.stats.mean_ns << "ns"
                      << "  stddev=" << result.stats.stddev_ns << "ns"
                      << "  min=" << result.stats.min_ns << "ns"
                      << "  max=" << result.stats.max_ns << "ns\n";
            collected.push_back({w.name, std::move(result)});
        } catch (const std::exception& e) {
            std::cerr << "sscope: workload " << w.name << " failed: " << e.what() << '\n';
            ++failed;
        }
    }

    if (failed) {
        std::cerr << "sscope: " << failed << " workload(s) failed\n";
        return 1;
    }

    // Serialize all results as a single Google Benchmark JSON document and
    // import via the standard pipeline (fingerprint, local write, best-effort sync).
    std::string json_str = sscope::build_run_json(collected, SSCOPE_BUILD_TYPE).dump();

    // Create a secure temp file; the RAII guard deletes it on every exit path.
    char tmp_path[] = "/tmp/sscope_run_XXXXXX.json";
    int  fd         = ::mkstemps(tmp_path, 5);
    if (fd < 0) {
        std::cerr << "sscope: failed to create temp file: " << strerror(errno) << '\n';
        return 1;
    }
    struct TmpGuard { char* p; ~TmpGuard() { ::unlink(p); } } guard{tmp_path};

    // Write full content, retrying on EINTR, failing on any other error or zero-byte write.
    {
        const char* buf  = json_str.data();
        ssize_t     left = static_cast<ssize_t>(json_str.size());
        while (left > 0) {
            ssize_t n = ::write(fd, buf, static_cast<size_t>(left));
            if (n < 0) {
                if (errno == EINTR) continue;
                // Flush fd before returning; ignore close() errors here.
                while (::close(fd) == -1 && errno == EINTR) {}
                std::cerr << "sscope: failed to write temp file: " << strerror(errno) << '\n';
                return 1;
            }
            if (n == 0) {
                while (::close(fd) == -1 && errno == EINTR) {}
                std::cerr << "sscope: unexpected zero-byte write to temp file\n";
                return 1;
            }
            buf  += n;
            left -= n;
        }
        // Close before passing path to importer; EINTR on close() is safe on macOS
        // (the fd is closed even when EINTR is returned).
        while (::close(fd) == -1 && errno == EINTR) {}
    }

    sscope::ImportOptions run_opts;
    run_opts.source_override = "synthetic";

    // import() may throw; TmpGuard ensures temp file is deleted regardless.
    try {
        auto result = importer.import(tmp_path, run_opts);
        std::cout << "Imported session " << result.session_id
                  << "  cases=" << result.cases_written << '\n';
    } catch (const std::exception& e) {
        std::cerr << "sscope: failed to import workload results: " << e.what() << '\n';
        return 1;
    }

    return 0;
}

static int cmd_import(const Options& opts) {
    if (opts.import_file.empty()) {
        std::cerr << "sscope import: no file specified\n";
        print_usage();
        return 1;
    }

    try {
        sscope::LocalDb db(opts.db_path);

        // §4.3: flush pending sessions before the primary operation if backend is reachable.
        if (!opts.server_url.empty()) {
            sscope::SyncClient sync_client(opts.server_url, opts.api_key);
            auto ps = sync_client.probe();
            if (ps == sscope::ProbeStatus::Reachable) {
                sscope::flush_pending_sessions(db, sync_client);
            } else if (ps == sscope::ProbeStatus::AuthFailed) {
                std::cerr << "[sscope] Warning: backend is reachable but authentication failed.\n"
                          << "         Pending sessions will not be retried until the API key is valid.\n"
                          << "         Allow Keychain access in the macOS dialog, or run"
                             " 'sscope register'.\n";
            }
            // ProbeStatus::Unreachable: continue silently — backend offline is expected.
        }

        sscope::BenchmarkImporter importer(db, opts.server_url, opts.api_key);
        sscope::ImportOptions import_opts{opts.commit_sha, opts.build_config_flag};
        sscope::ImportResult result = importer.import(opts.import_file, import_opts);

        std::cout << "imported session " << result.session_id << '\n'
                  << "  fingerprint: " << result.content_fingerprint << '\n'
                  << "  rows:        " << result.total_rows << '\n'
                  << "  cases:       " << result.cases_written << '\n';
        return 0;

    } catch (const sscope::ImportFileNotFound& e) {
        std::cerr << "sscope: " << e.what() << '\n';
        return 1;
    } catch (const sscope::ImportValidationError& e) {
        std::cerr << "sscope: " << e.what() << '\n';
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "sscope: import failed: " << e.what() << '\n';
        return 2;
    }
}

static int cmd_list(const Options& opts) {
    try {
        sscope::LocalDb db(opts.db_path);
        auto sessions = db.list_sessions();

        // Apply --source filter.
        if (!opts.source_filter.empty()) {
            sessions.erase(
                std::remove_if(sessions.begin(), sessions.end(),
                    [&](const sscope::SessionRow& s) {
                        return s.source != opts.source_filter;
                    }),
                sessions.end());
        }

        // Apply --limit.
        if (opts.limit > 0 && static_cast<int>(sessions.size()) > opts.limit)
            sessions.resize(static_cast<size_t>(opts.limit));

        if (sessions.empty()) {
            if (opts.output_format == "json") {
                std::cout << "[]\n";
            } else {
                std::cout << "no sessions found\n";
            }
            return 0;
        }

        if (opts.output_format == "json") {
            nlohmann::json arr = nlohmann::json::array();
            for (const auto& s : sessions) {
                nlohmann::json obj;
                obj["session_id"]   = s.session_id;
                obj["run_name"]     = s.run_name;
                obj["submitted_at"] = s.submitted_at;
                obj["sync_status"]  = s.sync_status;
                obj["source"]       = s.source;
                obj["isa"]          = s.isa;
                obj["os_version"]   = s.os_version;
                arr.push_back(obj);
            }
            std::cout << arr.dump(2) << '\n';
        } else {
            std::cout << std::left
                      << std::setw(36) << "session_id"
                      << "  " << std::setw(20) << "run_name"
                      << "  " << std::setw(20) << "submitted_at"
                      << "  " << "sync_status\n";
            std::cout << std::string(100, '-') << '\n';

            for (const auto& s : sessions) {
                std::cout << std::setw(36) << s.session_id
                          << "  " << std::setw(20) << s.run_name.substr(0, 20)
                          << "  " << std::setw(20) << s.submitted_at
                          << "  " << s.sync_status << '\n';
            }
        }
        return 0;

    } catch (const std::exception& e) {
        std::cerr << "sscope: " << e.what() << '\n';
        return 1;
    }
}

static int cmd_status(Options& opts) {
    std::cout << "sscope " << SSCOPE_VERSION << '\n';

    auto dev_id = sscope::try_load_device_id();
    std::cout << "Device ID:    "
              << (dev_id ? *dev_id : "(not registered)") << '\n';

    std::string url = opts.server_url.empty() ? sscope::load_server_url() : opts.server_url;
    std::cout << "Backend URL:  "
              << (url.empty() ? "(not configured)" : url) << '\n';

    if (!url.empty()) {
        std::string key = opts.api_key.empty() ? sscope::load_api_key() : opts.api_key;
        sscope::SyncClient client(url, key, 5); // 5s timeout for NFR-001
        auto ps = client.probe();
        std::string conn_str =
            ps == sscope::ProbeStatus::Reachable  ? "reachable" :
            ps == sscope::ProbeStatus::AuthFailed ? "reachable (authentication failed)" :
                                                     "unreachable";
        std::cout << "Connectivity: " << conn_str << '\n';
    } else {
        std::cout << "Connectivity: (not configured)\n";
    }

    std::string db_path = opts.db_path.empty()
                            ? sscope::LocalDb::default_path()
                            : opts.db_path;
    try {
        sscope::LocalDb db(db_path);
        auto pending = db.get_pending_sessions();
        std::cout << "Unsynced:     " << pending.size() << " session(s)\n";
    } catch (...) {
        std::cout << "Unsynced:     (unavailable)\n";
    }
    std::cout << "Storage:      " << db_path << '\n';
    return 0;
}

static int cmd_compare(const std::string& session_a, const std::string& session_b,
                       Options& opts) {
    if (opts.server_url.empty()) {
        std::cerr << "sscope: server URL not configured."
                     " Run 'sscope register --backend <url>' first.\n";
        return 3;
    }

    sscope::LocalDb db(opts.db_path);
    sscope::SyncClient client(opts.server_url, opts.api_key);

    auto probe_result = client.probe();
    if (probe_result == sscope::ProbeStatus::AuthFailed) {
        std::cerr << "sscope: authentication failed."
                     " Check your API key or run 'sscope register'.\n";
        return 3;
    }
    if (probe_result == sscope::ProbeStatus::Unreachable) {
        std::cerr << "sscope: backend unreachable at " << opts.server_url << '\n';
        return 3;
    }

    sscope::flush_pending_sessions(db, client);

    auto result = client.compare_sessions(session_a, session_b);

    if (result.http_code == 0) {
        std::cerr << "sscope: network error: " << result.body_json << '\n';
        return 3;
    }
    if (result.http_code == 404) {
        std::cerr << "sscope: one or both sessions not found."
                     " Use 'sscope list' to view available sessions.\n";
        return 1;
    }
    if (result.http_code == 401) {
        std::cerr << "sscope: authentication rejected by server.\n";
        return 3;
    }
    if (result.http_code == 422) {
        try {
            auto body = nlohmann::json::parse(result.body_json);
            if (body.contains("error") && body["error"].is_object()
                && body["error"].contains("message"))
                std::cerr << "sscope: sessions ineligible: "
                          << body["error"]["message"].get<std::string>() << '\n';
            else
                std::cerr << "sscope: sessions are ineligible for comparison.\n";
        } catch (...) {
            std::cerr << "sscope: sessions are ineligible for comparison.\n";
        }
        return 4;
    }
    if (result.http_code != 201) {
        std::cerr << "sscope: unexpected response (HTTP " << result.http_code << ")\n";
        return 3;
    }

    try {
        auto body = nlohmann::json::parse(result.body_json);

        // Confounding factors BEFORE the metric table (required by spec).
        if (body.contains("confounding_factors") && body["confounding_factors"].is_array()
            && !body["confounding_factors"].empty()) {
            std::cout << "Warning: confounding factors detected:\n";
            for (const auto& f : body["confounding_factors"]) {
                std::string line;
                if (f.is_string()) {
                    line = f.get<std::string>();
                } else if (f.is_object()) {
                    // Backend returns {flag, severity, value_a?, value_b?}
                    line = f.value("flag", "unknown");
                    std::string sev = f.value("severity", "");
                    if (!sev.empty()) line += " [" + sev + "]";
                    std::string va = f.value("value_a", "");
                    std::string vb = f.value("value_b", "");
                    if (!va.empty() || !vb.empty())
                        line += " (A: " + va + ", B: " + vb + ")";
                }
                std::cout << "  - " << line << '\n';
            }
            std::cout << '\n';
        }

        if (body.contains("mandatory_disclaimer") && body["mandatory_disclaimer"].is_string()
            && !body["mandatory_disclaimer"].get<std::string>().empty())
            std::cout << body["mandatory_disclaimer"].get<std::string>() << "\n\n";

        if (body.contains("per_metric_results") && body["per_metric_results"].is_array()) {
            std::cout << std::left
                      << std::setw(40) << "benchmark"
                      << "  " << std::setw(6) << "class"
                      << "  " << "summary\n";
            std::cout << std::string(90, '-') << '\n';
            for (const auto& m : body["per_metric_results"]) {
                std::string name = m.value("canonical_name", "");
                std::string cls  = m.value("classification", "");
                std::string summ = m.value("summary", "");
                std::cout << std::setw(40) << name.substr(0, 40)
                          << "  " << std::setw(6) << cls
                          << "  " << summ << '\n';
            }
            std::cout << '\n';
        }

        if (body.contains("overall_summary") && body["overall_summary"].is_string())
            std::cout << "Summary: " << body["overall_summary"].get<std::string>() << '\n';

        if (body.contains("rule_based_explanation") && body["rule_based_explanation"].is_string()
            && !body["rule_based_explanation"].get<std::string>().empty())
            std::cout << '\n' << body["rule_based_explanation"].get<std::string>() << '\n';

    } catch (const std::exception& e) {
        std::cerr << "sscope: failed to parse comparison response: " << e.what() << '\n';
        return 3;
    }
    return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    Options opts = parse_args(argc, argv);

    if (opts.command == "register") {
        if (opts.backend_url.empty()) {
            std::cerr << "sscope register: --backend <url> is required\n";
            return 1;
        }
        return sscope::cmd_register(opts.backend_url);
    }

    // For backend-connected commands, fill in stored credentials when absent.
    if (opts.command == "run" || opts.command == "import" || opts.command == "compare"
        || opts.command == "status")
        opts = apply_stored_credentials(opts);

    if (opts.command == "run")
        return cmd_run(opts);
    if (opts.command == "import")
        return cmd_import(opts);
    if (opts.command == "compare") {
        if (opts.positional_args.size() < 2) {
            std::cerr << "usage: sscope compare <session_a_id> <session_b_id>\n";
            return 1;
        }
        return cmd_compare(opts.positional_args[0], opts.positional_args[1], opts);
    }
    if (opts.command == "list")
        return cmd_list(opts);
    if (opts.command == "status")
        return cmd_status(opts);

    std::cerr << "sscope: unknown command: " << opts.command << '\n';
    print_usage();
    return 1;
}

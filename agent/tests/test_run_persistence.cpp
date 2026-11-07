#include <gtest/gtest.h>

#include "sscope/import/benchmark_importer.h"
#include "sscope/db/local_db.h"
#include "sscope/workloads/utils.h"
#include "sscope/workloads/workload_json.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

using sscope::BenchmarkImporter;
using sscope::ImportOptions;
using sscope::ImportResult;
using sscope::LocalDb;
using sscope::MeasurementRow;
using sscope::NamedWorkloadResult;
using sscope::WorkloadResult;
using sscope::build_run_json;

// ── Helpers ───────────────────────────────────────────────────────────────────

static std::string tmp_path(const std::string& suffix) {
    static std::atomic<int> counter{0};
    return "/tmp/sscope_test_run_persist_" + std::to_string(::getpid())
         + "_" + std::to_string(counter.fetch_add(1)) + suffix;
}

static void write_file(const std::string& path, const std::string& content) {
    std::ofstream f(path);
    f << content;
}

// Build a WorkloadResult with n_rows MeasurementRows.
// base_ns is the real_time_ns for row 0; each subsequent row increases by 1 ns.
static WorkloadResult make_workload(int n_rows, double base_ns) {
    WorkloadResult res;
    for (int i = 0; i < n_rows; ++i) {
        MeasurementRow row{};
        row.real_time_ns    = base_ns + static_cast<double>(i);
        row.cpu_time_ns     = base_ns * 0.98 + static_cast<double>(i);
        row.iterations      = 1'000'000ULL;
        row.bytes_per_second = 0.0;
        row.items_per_second = 0.0;
        res.raw_rows.push_back(row);
    }
    return res;
}

// Write a build_run_json document to a temp file and return the path.
// Caller is responsible for removing the file.
static std::string write_run_json(
        const std::vector<NamedWorkloadResult>& entries,
        const char* build_type) {
    std::string path = tmp_path(".json");
    std::string content = build_run_json(entries, build_type).dump();
    write_file(path, content);
    return path;
}

// ── Fixture ───────────────────────────────────────────────────────────────────

class RunPersistenceFixture : public ::testing::Test {
protected:
    std::string   db_path;
    std::unique_ptr<LocalDb> db;

    void SetUp() override {
        db_path = tmp_path(".db");
        db = std::make_unique<LocalDb>(db_path);
    }
    void TearDown() override {
        db.reset();
        for (const std::string& p : {db_path, db_path + "-wal", db_path + "-shm"})
            std::filesystem::remove(p);
    }
};

// Build 5 workload entries with the standard 30-row sample count.
static std::vector<NamedWorkloadResult> make_five_workloads() {
    return {
        {"BM_cpu_integer_lcg",   make_workload(30, 10.5)},
        {"BM_cpu_float_trig",    make_workload(30, 25.3)},
        {"BM_memory_seq_memcpy", make_workload(30, 50.0)},
        {"BM_memory_rand_chase", make_workload(30, 120.7)},
        {"BM_thread_scaling",    make_workload(30, 8.2)},
    };
}

// ── Test 1: source="synthetic" and source_marker="sscope-builtin" ────────────

TEST_F(RunPersistenceFixture, SyntheticSourceAndMarkerStored) {
    auto entries    = make_five_workloads();
    std::string path = write_run_json(entries, "Release");
    struct Guard { std::string p; ~Guard() { std::filesystem::remove(p); } } g{path};

    BenchmarkImporter imp(*db);
    ImportOptions     opts;
    opts.source_override = "synthetic";
    ImportResult result = imp.import(path, opts);

    auto session = db->get_session(result.session_id);
    ASSERT_TRUE(session.has_value());
    EXPECT_EQ(session->source, "synthetic");
    ASSERT_TRUE(session->source_marker.has_value());
    EXPECT_EQ(session->source_marker.value(), "sscope-builtin");
}

// ── Test 2: all 30 raw samples per workload preserved with correct units ──────

TEST_F(RunPersistenceFixture, AllSamplesPreservedWithCorrectUnits) {
    static constexpr int EXPECTED_ROWS    = 30;
    static constexpr int EXPECTED_CASES   = 5;
    static constexpr double BASE_REAL_NS  = 10.5; // base_ns for BM_cpu_integer_lcg

    auto entries     = make_five_workloads();
    std::string path = write_run_json(entries, "Debug");
    struct Guard { std::string p; ~Guard() { std::filesystem::remove(p); } } g{path};

    BenchmarkImporter imp(*db);
    ImportOptions     opts;
    opts.source_override = "synthetic";
    ImportResult result = imp.import(path, opts);

    // Verify case count.
    auto cases = db->get_benchmark_cases(result.session_id);
    ASSERT_EQ(static_cast<int>(cases.size()), EXPECTED_CASES);

    for (const auto& bc : cases) {
        EXPECT_EQ(bc.data_type, "raw_samples_available");

        nlohmann::json meas = nlohmann::json::parse(bc.measurements_json);
        ASSERT_TRUE(meas.contains("raw_rows"));
        ASSERT_TRUE(meas["raw_rows"].is_array());
        EXPECT_EQ(static_cast<int>(meas["raw_rows"].size()), EXPECTED_ROWS)
            << "case " << bc.canonical_name << " has wrong sample count";

        // Spot-check that real_time_ns is a number and cpu_time_ns is present.
        for (const auto& row : meas["raw_rows"]) {
            EXPECT_TRUE(row.contains("real_time_ns"));
            EXPECT_TRUE(row["real_time_ns"].is_number());
            EXPECT_GE(row["real_time_ns"].get<double>(), 0.0);
            EXPECT_TRUE(row.contains("cpu_time_ns"));
        }
    }

    // Verify exact timing for the first case (BM_cpu_integer_lcg, base_ns=10.5).
    // Cases are ordered by project_name, canonical_name — find by name.
    auto it = std::find_if(cases.begin(), cases.end(), [](const sscope::BenchmarkCaseRow& c) {
        return c.canonical_name == "BM_cpu_integer_lcg";
    });
    ASSERT_NE(it, cases.end()) << "BM_cpu_integer_lcg case not found";

    nlohmann::json m0 = nlohmann::json::parse(it->measurements_json);
    // Row 0: real_time_ns = BASE_REAL_NS + 0 = 10.5, stored via
    // to_nanoseconds(10.5, "ns") = 10.5 (identity).
    EXPECT_DOUBLE_EQ(m0["raw_rows"][0]["real_time_ns"].get<double>(), BASE_REAL_NS);
    EXPECT_DOUBLE_EQ(m0["raw_rows"][1]["real_time_ns"].get<double>(), BASE_REAL_NS + 1.0);
}

// ── Test 3: offline run stores session as "pending" ───────────────────────────

TEST_F(RunPersistenceFixture, OfflineRunSessionStoredAsPending) {
    auto entries     = make_five_workloads();
    std::string path = write_run_json(entries, "Release");
    struct Guard { std::string p; ~Guard() { std::filesystem::remove(p); } } g{path};

    // No server_url → sync block is skipped → session remains "pending".
    BenchmarkImporter imp(*db, /*server_url=*/"", /*api_key=*/"");
    ImportOptions     opts;
    opts.source_override = "synthetic";
    ImportResult result = imp.import(path, opts);

    auto session = db->get_session(result.session_id);
    ASSERT_TRUE(session.has_value());
    EXPECT_EQ(session->sync_status, "pending")
        << "offline import must leave session in pending state for later retry";

    // Session must be retrievable via get_pending_sessions().
    auto pending = db->get_pending_sessions();
    bool found = false;
    for (const auto& s : pending)
        if (s.session_id == result.session_id) { found = true; break; }
    EXPECT_TRUE(found) << "session not in pending queue";
}

// ── Test 4: failed sync preserves session locally as "pending" ────────────────
//
// A TCP connection to a port that is bound but not listening returns ECONNREFUSED
// immediately at the kernel level, with no timeout and no race with other processes.
// This deterministically exercises the stage-14 network-error path in the importer.

TEST_F(RunPersistenceFixture, SyncFailurePreservesSessionLocally) {
    // Allocate a free loopback port by binding a socket to port 0.
    // Without a listen() call, any TCP connect() to this port returns ECONNREFUSED.
    int sock = ::socket(AF_INET, SOCK_STREAM, 0);
    ASSERT_GE(sock, 0) << "socket() failed: " << strerror(errno);

    struct sockaddr_in addr{};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port        = 0;  // OS assigns a free port
    ASSERT_EQ(::bind(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)), 0)
        << "bind() failed: " << strerror(errno);

    socklen_t len = sizeof(addr);
    ASSERT_EQ(::getsockname(sock, reinterpret_cast<struct sockaddr*>(&addr), &len), 0)
        << "getsockname() failed: " << strerror(errno);
    int port = static_cast<int>(ntohs(addr.sin_port));
    ASSERT_GT(port, 0);

    // Keep the socket open (bound but not listening) for the duration of the import.
    struct SockGuard { int fd; ~SockGuard() { ::close(fd); } } sg{sock};

    std::string server_url = "http://127.0.0.1:" + std::to_string(port);

    auto entries     = make_five_workloads();
    std::string path = write_run_json(entries, "Release");
    struct Guard { std::string p; ~Guard() { std::filesystem::remove(p); } } g{path};

    BenchmarkImporter imp(*db, server_url, /*api_key=*/"dummy-key");
    ImportOptions     opts;
    opts.source_override = "synthetic";

    // import() must succeed locally even though the sync attempt fails.
    ImportResult result;
    ASSERT_NO_THROW(result = imp.import(path, opts))
        << "import must not throw when sync fails";

    // Session must exist in the local database.
    auto session = db->get_session(result.session_id);
    ASSERT_TRUE(session.has_value()) << "session must be stored locally after sync failure";

    // Sync failure must leave the session as "pending", not "conflict" or "synced".
    EXPECT_EQ(session->sync_status, "pending")
        << "sync failure must preserve session as pending for later retry";

    // Session must appear in the pending retry queue.
    auto pending = db->get_pending_sessions();
    bool found = std::any_of(pending.begin(), pending.end(),
        [&](const sscope::SessionRow& s) {
            return s.session_id == result.session_id;
        });
    EXPECT_TRUE(found) << "session must be in the pending retry queue";
}

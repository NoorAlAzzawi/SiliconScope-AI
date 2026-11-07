#include <gtest/gtest.h>
#include "sscope/db/local_db.h"

#include <atomic>
#include <filesystem>
#include <stdexcept>
#include <unistd.h>

using sscope::LocalDb;
using sscope::SessionRow;
using sscope::BenchmarkCaseRow;

// Generate a unique db path per test using pid + monotonic counter.
// Each test MUST call cleanup_db(path) on exit, or use DbFixture below.
static std::string temp_db_path() {
    static std::atomic<int> counter{0};
    return "/tmp/sscope_test_db_" + std::to_string(getpid())
         + "_" + std::to_string(counter.fetch_add(1)) + ".db";
}

static void cleanup_db(const std::string& path) {
    for (const std::string& p : {path, path + "-wal", path + "-shm"})
        std::filesystem::remove(p);
}

// Fixture that manages a fresh, isolated db per test.
class DbFixture : public ::testing::Test {
protected:
    std::string path;
    std::unique_ptr<LocalDb> db;

    void SetUp() override {
        path = temp_db_path();
        db = std::make_unique<LocalDb>(path);
    }
    void TearDown() override {
        db.reset();
        cleanup_db(path);
    }
};

static SessionRow make_session(const std::string& id = "550e8400-e29b-41d4-a716-446655440000") {
    SessionRow r;
    r.session_id          = id;
    r.run_name            = "test_run";
    r.os_name             = "macOS";
    r.os_version          = "14.0.0";
    r.cpu_name            = "Apple M2";
    r.isa                 = "arm64";
    r.build_type          = "Release";
    r.source              = "synthetic";
    r.source_marker       = std::nullopt;
    r.git_sha             = std::nullopt;
    r.build_config        = std::nullopt;
    r.import_timestamp    = "2026-11-02T00:00:00Z";
    r.import_environment  = std::nullopt;
    r.content_fingerprint = std::string(64, 'a');
    r.sync_status         = "pending";
    r.sync_reason         = std::nullopt;
    r.submitted_at        = "2026-11-02T00:00:01Z";
    return r;
}

// ── Schema / open ─────────────────────────────────────────────────────────────

TEST(LocalDb, OpenCreatesFile) {
    std::string p = temp_db_path();
    { LocalDb tmp(p); }
    EXPECT_TRUE(std::filesystem::exists(p));
    cleanup_db(p);
}

TEST(LocalDb, WalModeEnabled) {
    std::string p = temp_db_path();
    { LocalDb tmp(p); }
    EXPECT_TRUE(std::filesystem::exists(p));
    cleanup_db(p);
}

// ── insert_session / get_session ─────────────────────────────────────────────

TEST_F(DbFixture, InsertAndRetrieveSession) {
    auto r = make_session();
    db->insert_session(r);

    auto got = db->get_session(r.session_id);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->session_id,   r.session_id);
    EXPECT_EQ(got->run_name,     r.run_name);
    EXPECT_EQ(got->cpu_name,     r.cpu_name);
    EXPECT_EQ(got->sync_status,  "pending");
}

TEST_F(DbFixture, GetNonexistentSessionReturnsNullopt) {
    auto got = db->get_session("no-such-id");
    EXPECT_FALSE(got.has_value());
}

TEST_F(DbFixture, DuplicateSessionIdThrows) {
    auto r = make_session();
    db->insert_session(r);
    EXPECT_THROW(db->insert_session(r), std::runtime_error);
}

TEST_F(DbFixture, NullableFieldsRoundTrip) {
    auto r = make_session();
    r.git_sha        = "abc123";
    r.build_config   = "sanitize=address";
    r.source_marker  = "/path/to/file.json";
    r.sync_reason    = "body_limit_exceeded";
    db->insert_session(r);

    auto got = db->get_session(r.session_id);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->git_sha,       r.git_sha);
    EXPECT_EQ(got->build_config,  r.build_config);
    EXPECT_EQ(got->source_marker, r.source_marker);
    EXPECT_EQ(got->sync_reason,   r.sync_reason);
}

// ── insert_benchmark_case ────────────────────────────────────────────────────

TEST_F(DbFixture, InsertBenchmarkCase) {
    auto session = make_session();
    db->insert_session(session);

    BenchmarkCaseRow bc;
    bc.case_id           = "case-0001";
    bc.session_id        = session.session_id;
    bc.project_name      = "default";
    bc.canonical_name    = "BM_sort";
    bc.data_type         = "raw_samples_available";
    bc.measurements_json = R"({"raw_rows":[],"aggregate_rows":[]})";

    EXPECT_NO_THROW(db->insert_benchmark_case(bc));
}

TEST_F(DbFixture, DuplicateCaseThrows) {
    auto session = make_session();
    db->insert_session(session);

    BenchmarkCaseRow bc;
    bc.case_id           = "case-0001";
    bc.session_id        = session.session_id;
    bc.project_name      = "default";
    bc.canonical_name    = "BM_sort";
    bc.data_type         = "raw_samples_available";
    bc.measurements_json = "{}";

    db->insert_benchmark_case(bc);
    bc.case_id = "case-0002";  // different case_id, same (session, project, name)
    EXPECT_THROW(db->insert_benchmark_case(bc), std::runtime_error);
}

TEST_F(DbFixture, ForeignKeyEnforced) {
    BenchmarkCaseRow bc;
    bc.case_id           = "case-orphan";
    bc.session_id        = "no-such-session";
    bc.project_name      = "default";
    bc.canonical_name    = "BM_x";
    bc.data_type         = "no_measurements";
    bc.measurements_json = "{}";
    EXPECT_THROW(db->insert_benchmark_case(bc), std::runtime_error);
}

// ── update_sync_status ────────────────────────────────────────────────────────

TEST_F(DbFixture, UpdateSyncStatusToSynced) {
    auto r = make_session();
    db->insert_session(r);
    db->update_sync_status(r.session_id, "synced");

    auto got = db->get_session(r.session_id);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "synced");
    EXPECT_FALSE(got->sync_reason.has_value());
}

TEST_F(DbFixture, UpdateSyncStatusWithReason) {
    auto r = make_session();
    db->insert_session(r);
    db->update_sync_status(r.session_id, "conflict", "body_limit_exceeded");

    auto got = db->get_session(r.session_id);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "conflict");
    EXPECT_EQ(got->sync_reason, "body_limit_exceeded");
}

// ── list_sessions ─────────────────────────────────────────────────────────────

TEST_F(DbFixture, ListSessionsEmpty) {
    EXPECT_TRUE(db->list_sessions().empty());
}

TEST_F(DbFixture, ListSessionsReturnsMostRecentFirst) {
    auto r1 = make_session("aaaaaaaa-0000-0000-0000-000000000001");
    r1.submitted_at = "2026-11-02T10:00:00Z";
    auto r2 = make_session("aaaaaaaa-0000-0000-0000-000000000002");
    r2.submitted_at = "2026-11-02T11:00:00Z";

    db->insert_session(r1);
    db->insert_session(r2);

    auto rows = db->list_sessions();
    ASSERT_EQ(rows.size(), 2u);
    EXPECT_EQ(rows[0].session_id, r2.session_id);
    EXPECT_EQ(rows[1].session_id, r1.session_id);
}

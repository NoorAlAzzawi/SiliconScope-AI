#include "sscope/sync/pending_flush.h"
#include "sscope/db/local_db.h"
#include "sscope/sync/sync_client.h"

#include <gtest/gtest.h>

#include <atomic>
#include <filesystem>
#include <string>
#include <unistd.h>

using sscope::LocalDb;
using sscope::SessionRow;
using sscope::BenchmarkCaseRow;
using sscope::SyncClient;
using sscope::SyncResult;
using sscope::CompareResult;
using sscope::SyncStatus;
using sscope::ProbeStatus;

// ── Helpers ──────────────────────────────────────────────────────────────────

static std::string temp_db_path() {
    static std::atomic<int> counter{0};
    return "/tmp/sscope_flush_test_" + std::to_string(getpid())
         + "_" + std::to_string(counter.fetch_add(1)) + ".db";
}

static void cleanup_db(const std::string& path) {
    for (const std::string& p : {path, path + "-wal", path + "-shm"})
        std::filesystem::remove(p);
}

static SessionRow make_pending_session(const std::string& id) {
    SessionRow r;
    r.session_id          = id;
    r.run_name            = "test_pending_run";
    r.os_name             = "macOS";
    r.os_version          = "14.0.0";
    r.cpu_name            = "Apple M2";
    r.isa                 = "arm64";
    r.build_type          = "Release";
    r.source              = "user-supplied import";
    r.source_marker       = "/tmp/test.json";
    r.git_sha             = std::nullopt;
    r.build_config        = std::nullopt;
    r.import_timestamp    = "2026-11-04T10:00:00Z";
    r.import_environment  = R"({"cpu_name":"Apple M2","isa":"arm64"})";
    r.content_fingerprint = std::string(64, 'a');
    r.sync_status         = "pending";
    r.sync_reason         = std::nullopt;
    r.submitted_at        = "2026-11-04T10:00:01Z";
    return r;
}

// ── Mock SyncClient ───────────────────────────────────────────────────────────

class MockSyncClient200 : public SyncClient {
public:
    MockSyncClient200()
        : SyncClient("http://mock", "mock-key") {}

    SyncResult post_run(const std::string& /*body_json*/) const override {
        return {SyncStatus::Success, 200, R"({"session_id":"mock-id"})"};
    }

    ProbeStatus probe() const override { return ProbeStatus::Reachable; }

    CompareResult compare_sessions(const std::string&, const std::string&) const override {
        return {200, "{}"};
    }
};

class MockSyncClient201 : public SyncClient {
public:
    MockSyncClient201()
        : SyncClient("http://mock", "mock-key") {}

    SyncResult post_run(const std::string& /*body_json*/) const override {
        return {SyncStatus::Success, 201, R"({"session_id":"mock-id"})"};
    }

    ProbeStatus probe() const override { return ProbeStatus::Reachable; }

    CompareResult compare_sessions(const std::string&, const std::string&) const override {
        return {200, "{}"};
    }
};

class MockSyncClient409 : public SyncClient {
public:
    MockSyncClient409()
        : SyncClient("http://mock", "mock-key") {}

    SyncResult post_run(const std::string& /*body_json*/) const override {
        return {SyncStatus::Conflict, 409, R"({"error":"fingerprint_conflict"})"};
    }

    ProbeStatus probe() const override { return ProbeStatus::Reachable; }

    CompareResult compare_sessions(const std::string&, const std::string&) const override {
        return {200, "{}"};
    }
};

class MockSyncClientNetworkError : public SyncClient {
public:
    MockSyncClientNetworkError()
        : SyncClient("http://mock", "mock-key") {}

    SyncResult post_run(const std::string& /*body_json*/) const override {
        return {SyncStatus::NetworkError, 0, "connection refused"};
    }

    ProbeStatus probe() const override { return ProbeStatus::Unreachable; }

    CompareResult compare_sessions(const std::string&, const std::string&) const override {
        return {0, "connection refused"};
    }
};

// Mock for HTTP 401 — authentication rejected by server.
class MockSyncClientAuthError : public SyncClient {
public:
    MockSyncClientAuthError()
        : SyncClient("http://mock", "") {} // empty key simulates missing credential

    SyncResult post_run(const std::string& /*body_json*/) const override {
        return {SyncStatus::AuthError, 401, R"({"error":{"code":"UNAUTHORIZED"}})"};
    }

    ProbeStatus probe() const override { return ProbeStatus::AuthFailed; }

    CompareResult compare_sessions(const std::string&, const std::string&) const override {
        return {401, R"({"error":{"code":"UNAUTHORIZED"}})"};
    }
};

// ── Fixture ───────────────────────────────────────────────────────────────────

class PendingFlushFixture : public ::testing::Test {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

TEST_F(PendingFlushFixture, NoPendingSessionsReturnsZero) {
    MockSyncClient200 mock;
    int result = sscope::flush_pending_sessions(*db, mock);
    EXPECT_EQ(result, 0);
}

TEST_F(PendingFlushFixture, OnePendingSession200BecomeSynced) {
    const std::string sid = "aaaaaaaa-0000-4000-8000-000000000001";
    db->insert_session(make_pending_session(sid));

    MockSyncClient200 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 1);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "synced");
}

TEST_F(PendingFlushFixture, OnePendingSession201BecomeSynced) {
    const std::string sid = "aaaaaaaa-0000-4000-8000-000000000002";
    db->insert_session(make_pending_session(sid));

    MockSyncClient201 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 1);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "synced");
}

TEST_F(PendingFlushFixture, OnePendingSession409BecomeConflict) {
    const std::string sid = "aaaaaaaa-0000-4000-8000-000000000003";
    db->insert_session(make_pending_session(sid));

    MockSyncClient409 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 0);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "conflict");
    EXPECT_EQ(got->sync_reason, "session_conflict");
}

TEST_F(PendingFlushFixture, OnePendingSessionNetworkErrorRemaindsPending) {
    const std::string sid = "aaaaaaaa-0000-4000-8000-000000000004";
    db->insert_session(make_pending_session(sid));

    MockSyncClientNetworkError mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 0);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "pending");
}

TEST_F(PendingFlushFixture, MultiplePendingSessionsAllSynced) {
    const std::string sid1 = "bbbbbbbb-0000-4000-8000-000000000001";
    const std::string sid2 = "bbbbbbbb-0000-4000-8000-000000000002";
    const std::string sid3 = "bbbbbbbb-0000-4000-8000-000000000003";

    auto s1 = make_pending_session(sid1); s1.submitted_at = "2026-11-04T10:00:01Z";
    auto s2 = make_pending_session(sid2); s2.submitted_at = "2026-11-04T10:00:02Z";
    auto s3 = make_pending_session(sid3); s3.submitted_at = "2026-11-04T10:00:03Z";

    db->insert_session(s1);
    db->insert_session(s2);
    db->insert_session(s3);

    MockSyncClient200 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 3);

    for (const std::string& sid : {sid1, sid2, sid3}) {
        auto got = db->get_session(sid);
        ASSERT_TRUE(got.has_value());
        EXPECT_EQ(got->sync_status, "synced");
    }
}

TEST_F(PendingFlushFixture, AlreadySyncedSessionNotRetried) {
    const std::string sid = "cccccccc-0000-4000-8000-000000000001";
    auto session = make_pending_session(sid);
    session.sync_status = "synced";
    db->insert_session(session);

    MockSyncClient200 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    // A synced session should not be retried; count stays 0.
    EXPECT_EQ(result, 0);
}

TEST_F(PendingFlushFixture, SessionWithBenchmarkCasesIsRetried) {
    const std::string sid = "dddddddd-0000-4000-8000-000000000001";
    db->insert_session(make_pending_session(sid));

    // Add a benchmark case for the session.
    BenchmarkCaseRow bc;
    bc.case_id           = "case-0001-" + sid.substr(0, 8);
    bc.session_id        = sid;
    bc.project_name      = "default";
    bc.canonical_name    = "BM_PendingTest";
    bc.data_type         = "raw_samples_available";
    bc.measurements_json = R"({"raw_rows":[{"real_time_ns":500.0}],"aggregate_rows":[]})";
    db->insert_benchmark_case(bc);

    MockSyncClient200 mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 1);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "synced");
}

// ── AuthError tests ───────────────────────────────────────────────────────────

// HTTP 401 from server: single pending session remains pending.
TEST_F(PendingFlushFixture, AuthError401KeepsSessionPending) {
    const std::string sid = "eeeeeeee-0000-4000-8000-000000000001";
    db->insert_session(make_pending_session(sid));

    MockSyncClientAuthError mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 0);

    auto got = db->get_session(sid);
    ASSERT_TRUE(got.has_value());
    EXPECT_EQ(got->sync_status, "pending")
        << "AuthError must not transition session to conflict or synced";
}

// HTTP 401 bails out early: second session is never attempted.
TEST_F(PendingFlushFixture, AuthError401BailsEarlyLeavesAllPending) {
    const std::string sid1 = "eeeeeeee-0000-4000-8000-000000000002";
    const std::string sid2 = "eeeeeeee-0000-4000-8000-000000000003";

    auto s1 = make_pending_session(sid1); s1.submitted_at = "2026-11-04T10:00:01Z";
    auto s2 = make_pending_session(sid2); s2.submitted_at = "2026-11-04T10:00:02Z";

    db->insert_session(s1);
    db->insert_session(s2);

    MockSyncClientAuthError mock;
    int result = sscope::flush_pending_sessions(*db, mock);

    EXPECT_EQ(result, 0);

    // Both sessions must remain pending — the break prevents the second attempt.
    for (const std::string& sid : {sid1, sid2}) {
        auto got = db->get_session(sid);
        ASSERT_TRUE(got.has_value());
        EXPECT_EQ(got->sync_status, "pending")
            << "Session " << sid << " should remain pending after auth failure";
    }
}

// SyncStatus::AuthError is a distinct value from NetworkError and ServerError.
TEST(SyncStatusTest, AuthErrorIsDistinctFromNetworkAndServerError) {
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::NetworkError);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::ServerError);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::Conflict);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::Success);
}

// ProbeStatus::AuthFailed is distinct from Unreachable and Reachable.
TEST(ProbeStatusTest, AuthFailedIsDistinctFromUnreachableAndReachable) {
    EXPECT_NE(sscope::ProbeStatus::AuthFailed, sscope::ProbeStatus::Unreachable);
    EXPECT_NE(sscope::ProbeStatus::AuthFailed, sscope::ProbeStatus::Reachable);
}

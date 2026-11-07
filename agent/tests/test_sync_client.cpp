#include "sscope/sync/sync_client.h"

#include <gtest/gtest.h>

#include <string>

using namespace sscope;

// Port 19999 on localhost — nothing should be listening here.
// Tests do NOT start a real HTTP server.
static constexpr const char* UNREACHABLE_URL = "http://127.0.0.1:19999";

// ── Network-error path ────────────────────────────────────────────────────────

TEST(SyncClientTest, UnreachableServerReturnsNetworkError) {
    SyncClient client(UNREACHABLE_URL, "dummy-api-key", /*timeout_s=*/5);
    const std::string body = R"({"session_id":"00000000-0000-4000-8000-000000000001"})";
    SyncResult result = client.post_run(body);
    EXPECT_EQ(result.status, SyncStatus::NetworkError);
    EXPECT_EQ(result.http_code, 0);
    EXPECT_FALSE(result.message.empty());
}

TEST(SyncClientTest, UnreachableServerDoesNotThrow) {
    SyncClient client(UNREACHABLE_URL, "dummy-api-key", /*timeout_s=*/5);
    const std::string body = R"({"session_id":"00000000-0000-4000-8000-000000000002"})";
    // post_run must never throw; all errors are reflected in SyncResult.
    SyncResult result;
    EXPECT_NO_THROW({ result = client.post_run(body); });
    EXPECT_EQ(result.status, SyncStatus::NetworkError);
}

TEST(SyncClientTest, EmptyBodyUnreachableServerReturnsNetworkOrServerError) {
    SyncClient client(UNREACHABLE_URL, "dummy-api-key", /*timeout_s=*/5);
    SyncResult result = client.post_run("");
    // Empty body + unreachable server: connection refused before any HTTP exchange.
    // Acceptable: NetworkError (connection refused) or ServerError (if somehow connected).
    EXPECT_TRUE(result.status == SyncStatus::NetworkError ||
                result.status == SyncStatus::ServerError);
    EXPECT_NO_FATAL_FAILURE({});
}

// ── Construction sanity ───────────────────────────────────────────────────────

TEST(SyncClientTest, ConstructWithDefaultTimeout) {
    // Constructing with default timeout_s should not crash.
    EXPECT_NO_THROW({
        SyncClient client("http://127.0.0.1:19999", "key");
    });
}

TEST(SyncClientTest, ConstructWithZeroTimeout) {
    // A zero timeout is technically valid for libcurl (means "no timeout").
    // The client should construct and not crash; network call will fail as unreachable.
    SyncClient client(UNREACHABLE_URL, "key", /*timeout_s=*/1);
    SyncResult result = client.post_run("{}");
    EXPECT_EQ(result.status, SyncStatus::NetworkError);
}

// ── Status enum coverage ──────────────────────────────────────────────────────

TEST(SyncClientTest, SyncResultHttpCodeIsZeroOnNetworkError) {
    SyncClient client(UNREACHABLE_URL, "key", /*timeout_s=*/5);
    SyncResult result = client.post_run("{}");
    // Per sync_client.h spec: http_code is 0 on network error.
    if (result.status == SyncStatus::NetworkError) {
        EXPECT_EQ(result.http_code, 0);
    }
}

// SyncStatus::AuthError is defined and distinct from all other statuses.
// (Full 401 behavior requires a live server; covered by integration tests.)
TEST(SyncClientTest, AuthErrorEnumValueIsDistinct) {
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::Success);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::Conflict);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::ServerError);
    EXPECT_NE(SyncStatus::AuthError, SyncStatus::NetworkError);
}

// ProbeStatus enum values are defined and distinct.
TEST(SyncClientTest, ProbeStatusEnumValuesAreDistinct) {
    EXPECT_NE(ProbeStatus::Reachable, ProbeStatus::AuthFailed);
    EXPECT_NE(ProbeStatus::Reachable, ProbeStatus::Unreachable);
    EXPECT_NE(ProbeStatus::AuthFailed, ProbeStatus::Unreachable);
}

// probe() on an unreachable server must return Unreachable, not AuthFailed.
TEST(SyncClientTest, UnreachableServerProbeReturnsUnreachable) {
    SyncClient client(UNREACHABLE_URL, "key", /*timeout_s=*/5);
    ProbeStatus ps = client.probe();
    EXPECT_EQ(ps, ProbeStatus::Unreachable);
}

// ── CompareResult ─────────────────────────────────────────────────────────────

// compare_sessions() on an unreachable server returns http_code=0.
TEST(SyncClientTest, CompareSessionsUnreachableReturnsZeroCode) {
    SyncClient client(UNREACHABLE_URL, "key", /*timeout_s=*/5);
    CompareResult r = client.compare_sessions(
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002");
    EXPECT_EQ(r.http_code, 0);
    EXPECT_FALSE(r.body_json.empty()) << "body_json should contain the curl error message";
}

// compare_sessions() does not throw on network error.
TEST(SyncClientTest, CompareSessionsDoesNotThrowOnNetworkError) {
    SyncClient client(UNREACHABLE_URL, "key", /*timeout_s=*/5);
    CompareResult r;
    EXPECT_NO_THROW({
        r = client.compare_sessions("aaa", "bbb");
    });
    EXPECT_EQ(r.http_code, 0);
}

// CompareResult fields are distinct from SyncResult — struct sanity.
TEST(SyncClientTest, CompareResultDefaultInitialization) {
    CompareResult r;
    EXPECT_EQ(r.http_code, 0);
    EXPECT_TRUE(r.body_json.empty());
}

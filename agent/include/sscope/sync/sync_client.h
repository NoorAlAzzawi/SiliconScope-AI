#pragma once

#include <string>

namespace sscope {

enum class SyncStatus {
    Success,      // HTTP 201 or 200 (idempotent retry)
    Conflict,     // HTTP 409 (fingerprint_conflict)
    AuthError,    // HTTP 401 — credentials missing, revoked, or rejected by server
    ServerError,  // HTTP 4xx/5xx other than 401/409
    NetworkError, // curl error, timeout, connection refused
};

// Result of a probe() call, distinguishing network reachability from auth status.
enum class ProbeStatus {
    Reachable,    // Backend responded with any HTTP status except 401
    AuthFailed,   // Backend responded 401 — reachable but credentials are invalid
    Unreachable,  // curl error, connection refused, or timeout
};

struct SyncResult {
    SyncStatus status;
    int http_code;       // 0 on network error
    std::string message; // human-readable detail
};

struct CompareResult {
    int http_code = 0;   // 0 on network error
    std::string body_json;
};

class SyncClient {
public:
    // server_url: base URL, e.g. "http://localhost:3000"
    // api_key:    raw API key sent as Bearer token
    // timeout_s:  connection + transfer timeout in seconds
    explicit SyncClient(const std::string& server_url,
                        const std::string& api_key,
                        long timeout_s = 30);

    virtual ~SyncClient() = default;

    // POST body_json to /api/v1/runs.
    // Never throws; all errors are reflected in SyncResult.
    virtual SyncResult post_run(const std::string& body_json) const;

    // Probe the backend reachability and authentication status.
    // Returns Reachable if any non-401 HTTP response is received.
    // Returns AuthFailed if the backend responds 401 (reachable but auth broken).
    // Returns Unreachable on curl error or connection refused.
    // Never throws.
    virtual ProbeStatus probe() const;

    // POST to /api/v1/comparisons with {session_a_id, session_b_id}.
    // Returns CompareResult with http_code=0 on network error.
    // Never throws.
    virtual CompareResult compare_sessions(const std::string& session_a_id,
                                           const std::string& session_b_id) const;

private:
    std::string server_url_;
    std::string api_key_;
    long timeout_s_;
};

} // namespace sscope

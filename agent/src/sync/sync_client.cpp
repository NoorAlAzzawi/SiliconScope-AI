#include "sscope/sync/sync_client.h"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <string>

namespace sscope {

namespace {

// libcurl write callback — appends received data to a std::string.
static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* buf = static_cast<std::string*>(userdata);
    buf->append(ptr, size * nmemb);
    return size * nmemb;
}

} // anonymous namespace

SyncClient::SyncClient(const std::string& server_url,
                       const std::string& api_key,
                       long timeout_s)
    : server_url_(server_url), api_key_(api_key), timeout_s_(timeout_s) {}

SyncResult SyncClient::post_run(const std::string& body_json) const {
    CURL* curl = curl_easy_init();
    if (!curl)
        return {SyncStatus::NetworkError, 0, "curl_easy_init failed"};

    std::string url = server_url_ + "/api/v1/runs";
    std::string auth_header = "Authorization: Bearer " + api_key_;
    std::string response_body;
    long http_code = 0;

    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, auth_header.c_str());

    curl_easy_setopt(curl, CURLOPT_URL,            url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,            1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,      body_json.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,   (long)body_json.size());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,      headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,   write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,       &response_body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,         timeout_s_);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT,  10L);
    // Do not follow redirects for a POST endpoint.
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION,  0L);

    CURLcode rc = curl_easy_perform(curl);

    if (rc != CURLE_OK) {
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return {SyncStatus::NetworkError, 0,
                std::string("curl error: ") + curl_easy_strerror(rc)};
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (http_code == 200 || http_code == 201)
        return {SyncStatus::Success, static_cast<int>(http_code), response_body};
    if (http_code == 409)
        return {SyncStatus::Conflict, 409, response_body};
    if (http_code == 401)
        return {SyncStatus::AuthError, 401, response_body};

    return {SyncStatus::ServerError, static_cast<int>(http_code), response_body};
}

ProbeStatus SyncClient::probe() const {
    CURL* curl = curl_easy_init();
    if (!curl) return ProbeStatus::Unreachable;

    std::string url = server_url_ + "/api/v1/runs";
    std::string auth_header = "Authorization: Bearer " + api_key_;
    std::string response_body;
    long http_code = 0;

    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, auth_header.c_str());

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPGET,        1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &response_body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        10L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);

    CURLcode rc = curl_easy_perform(curl);

    if (rc == CURLE_OK)
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK || http_code == 0)
        return ProbeStatus::Unreachable;
    if (http_code == 401)
        return ProbeStatus::AuthFailed;
    return ProbeStatus::Reachable;
}

CompareResult SyncClient::compare_sessions(const std::string& a,
                                            const std::string& b) const {
    CURL* curl = curl_easy_init();
    if (!curl)
        return {0, "curl_easy_init failed"};

    std::string url = server_url_ + "/api/v1/comparisons";
    std::string auth_header = "Authorization: Bearer " + api_key_;

    nlohmann::json body_obj;
    body_obj["session_a_id"] = a;
    body_obj["session_b_id"] = b;
    std::string body_str = body_obj.dump();

    std::string response_body;
    long http_code = 0;

    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, auth_header.c_str());

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,     body_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,  (long)body_str.size());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &response_body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        timeout_s_);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);

    CURLcode rc = curl_easy_perform(curl);

    if (rc != CURLE_OK) {
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return {0, std::string("curl error: ") + curl_easy_strerror(rc)};
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    return {static_cast<int>(http_code), response_body};
}

} // namespace sscope

#include "sscope/cli_options.h"

#include <gtest/gtest.h>

// These tests use lambda injection to prove load_api_key() call behavior
// without touching the macOS Keychain.

TEST(CredentialsTest, NoServerUrl_LoadApiKeyNotCalled) {
    bool api_key_loaded = false;
    sscope::Options opts; // server_url = ""
    auto result = sscope::apply_stored_credentials_impl(
        opts,
        [] { return std::string(""); },
        [&] { api_key_loaded = true; return std::string("mock-key"); }
    );
    EXPECT_FALSE(api_key_loaded);
    EXPECT_TRUE(result.api_key.empty());
}

TEST(CredentialsTest, WithServerUrl_LoadApiKeyCalled) {
    bool api_key_loaded = false;
    sscope::Options opts; // server_url = ""
    auto result = sscope::apply_stored_credentials_impl(
        opts,
        [] { return std::string("http://localhost:3000"); },
        [&] { api_key_loaded = true; return std::string("mock-key"); }
    );
    EXPECT_TRUE(api_key_loaded);
    EXPECT_EQ(result.api_key, "mock-key");
    EXPECT_EQ(result.server_url, "http://localhost:3000");
}

TEST(CredentialsTest, ExplicitServerUrl_LoadServerUrlNotCalled) {
    bool server_url_loaded = false;
    sscope::Options opts;
    opts.server_url = "http://explicit:3000";
    auto result = sscope::apply_stored_credentials_impl(
        opts,
        [&] { server_url_loaded = true; return std::string("http://stored:3000"); },
        [] { return std::string(""); }
    );
    EXPECT_FALSE(server_url_loaded);
    EXPECT_EQ(result.server_url, "http://explicit:3000");
}

TEST(CredentialsTest, ExplicitApiKey_LoadApiKeyNotCalled) {
    bool api_key_loaded = false;
    sscope::Options opts;
    opts.server_url = "http://localhost:3000";
    opts.api_key    = "provided-key";
    auto result = sscope::apply_stored_credentials_impl(
        opts,
        [] { return std::string("http://stored:3000"); },
        [&] { api_key_loaded = true; return std::string("mock-key"); }
    );
    EXPECT_FALSE(api_key_loaded);
    EXPECT_EQ(result.api_key, "provided-key");
}

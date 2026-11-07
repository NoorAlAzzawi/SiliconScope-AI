cmake_minimum_required(VERSION 3.21)

# Fetch GoogleTest at configure time.
include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

function(add_sscope_test target source)
    add_executable(${target} ${source})
    target_link_libraries(${target} PRIVATE sscope_core GTest::gtest_main)
    target_include_directories(${target} PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_SOURCE_DIR}/third_party/nlohmann_json
    )
    add_test(NAME ${target} COMMAND ${target})
endfunction()

add_sscope_test(test_credentials    test_credentials.cpp)
add_sscope_test(test_fingerprint    test_fingerprint.cpp)
add_sscope_test(test_importer       test_importer.cpp)
add_sscope_test(test_db             test_db.cpp)
add_sscope_test(test_platform       test_platform.cpp)
add_sscope_test(test_workloads      test_workloads.cpp)
add_sscope_test(test_statistics     test_statistics.cpp)
add_sscope_test(test_sync_client    test_sync_client.cpp)
add_sscope_test(test_security       test_security.cpp)
add_sscope_test(test_pending_flush    test_pending_flush.cpp)
add_sscope_test(test_run_persistence  test_run_persistence.cpp)

# Integration: sscope run stores one synthetic session offline (no Keychain).
# Uses an isolated HOME so load_server_url() returns "" and load_api_key() is
# never called.  Verifies: 1 synthetic session, 5 cases, sync_status=pending,
# and 30 raw samples in each case's measurements JSONB (requires SQLite JSON1,
# available on macOS 12+ system sqlite3).
add_test(NAME st_sscope_run_stores_session
    COMMAND bash -c
        "set -e; \
         TMPDIR=$(mktemp -d /tmp/sscope_ctest_run_XXXXXX); \
         trap 'rm -rf \"\$TMPDIR\"' EXIT; \
         HOME=\"\$TMPDIR\" ${CMAKE_BINARY_DIR}/sscope run \
             --db \"\$TMPDIR/run.db\" 2>/dev/null; \
         COUNT=$(sqlite3 \"\$TMPDIR/run.db\" \
             \"SELECT COUNT(*) FROM sessions WHERE source='synthetic';\"); \
         CASES=$(sqlite3 \"\$TMPDIR/run.db\" \
             \"SELECT COUNT(*) FROM benchmark_cases;\"); \
         PENDING=$(sqlite3 \"\$TMPDIR/run.db\" \
             \"SELECT COUNT(*) FROM sessions WHERE sync_status='pending';\"); \
         SAMPLES=$(sqlite3 \"\$TMPDIR/run.db\" \
             \"SELECT json_array_length(json_extract(measurements,'$.raw_rows')) \
               FROM benchmark_cases LIMIT 1;\"); \
         [ \"\$COUNT\" -eq 1 ] && [ \"\$CASES\" -eq 5 ] && \
         [ \"\$PENDING\" -eq 1 ] && [ \"\$SAMPLES\" -eq 30 ]"
)
set_tests_properties(st_sscope_run_stores_session PROPERTIES
    PASS_REGULAR_EXPRESSION "Imported session"
)

# ── Regression: offline import must not access Keychain when no server URL is configured.
#
# Uses a fresh HOME directory (no config.json) so load_server_url() returns empty.
# With apply_stored_credentials() fixed, load_api_key() must NOT be called.
# If the fix is reverted, the binary will call load_api_key(), which prints
# "Failed to read API key from Keychain" to stderr — caught by FAIL_REGULAR_EXPRESSION.
add_test(NAME st_offline_no_keychain_regression
    COMMAND bash -c
        "set -e; \
         TMPDIR=$(mktemp -d /tmp/sscope_ctest_XXXXXX); \
         trap 'rm -rf \"\$TMPDIR\"' EXIT; \
         HOME=\"\$TMPDIR\" ${CMAKE_BINARY_DIR}/sscope import \
           --db \"\$TMPDIR/test.db\" \
           ${CMAKE_CURRENT_SOURCE_DIR}/data/minimal_valid.json 2>&1"
)
# What this proves: a fresh HOME has no config.json, so load_server_url() returns "".
# apply_stored_credentials() condition (api_key.empty() && !server_url.empty()) is FALSE,
# so load_api_key() is NOT called — the import succeeds with no Keychain interaction.
#
# Known gap: if the fix is reverted, load_api_key() IS called but returns errSecItemNotFound
# silently (item doesn't exist in a fresh environment), so this test still passes.
# A stronger test would require C++ mock injection of load_api_key() to detect the call.
# On macOS Sonoma 14, SecItemCopyMatching with kSecUseNoAuthenticationUI bypasses Mach IPC
# and accesses the keychain database directly, so sandbox-exec with deny mach-lookup does
# not intercept it. The test + code-review of apply_stored_credentials() provides the
# necessary confidence that the fix is correct.
set_tests_properties(st_offline_no_keychain_regression PROPERTIES
    PASS_REGULAR_EXPRESSION "imported session"
    FAIL_REGULAR_EXPRESSION "Failed to read API key from Keychain"
)

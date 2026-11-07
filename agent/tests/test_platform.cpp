#include <gtest/gtest.h>
#include "sscope/platform/platform_adapter.h"

using sscope::make_platform_adapter;
using sscope::PlatformInfo;

// These tests run on macOS CI only; they exercise the real sysctl calls.
// A value of "unavailable" is acceptable for genuinely undetectable fields;
// the tests verify presence and format, not specific hardware values.

TEST(PlatformAdapter, GatherDoesNotThrow) {
    auto adapter = make_platform_adapter();
    ASSERT_NE(adapter, nullptr);
    EXPECT_NO_THROW(adapter->gather());
}

TEST(PlatformAdapter, CpuNameNonEmpty) {
    auto info = make_platform_adapter()->gather();
    EXPECT_FALSE(info.cpu_name.empty());
}

TEST(PlatformAdapter, IsaIsKnownValue) {
    auto info = make_platform_adapter()->gather();
    EXPECT_TRUE(info.isa == "arm64"     ||
                info.isa == "x86_64"    ||
                info.isa == "unavailable")
        << "unexpected isa: " << info.isa;
}

TEST(PlatformAdapter, OsNameIsMacOS) {
    auto info = make_platform_adapter()->gather();
    EXPECT_EQ(info.os_name, "macOS");
}

TEST(PlatformAdapter, OsVersionHasDots) {
    auto info = make_platform_adapter()->gather();
    if (info.os_version != "unavailable") {
        // Expect at least "X.Y" format.
        EXPECT_NE(info.os_version.find('.'), std::string::npos)
            << "os_version lacks dot: " << info.os_version;
    }
}

TEST(PlatformAdapter, LogicalCoresPositive) {
    auto info = make_platform_adapter()->gather();
    EXPECT_GT(info.logical_cores, 0u);
}

TEST(PlatformAdapter, TotalMemPositive) {
    auto info = make_platform_adapter()->gather();
    EXPECT_GT(info.total_mem_bytes, 0ull);
}

TEST(PlatformAdapter, UnavailableFieldsAreString) {
    // Verify fields use the sentinel "unavailable" not empty string,
    // so they're never serialised as "" in the canonical JSON.
    auto info = make_platform_adapter()->gather();
    EXPECT_NE(info.cpu_name,   "");
    EXPECT_NE(info.isa,        "");
    EXPECT_NE(info.os_name,    "");
    EXPECT_NE(info.os_version, "");
}

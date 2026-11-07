// RFC 8785 / fingerprint conformance tests.
//
// All 13 CT vectors from API_CONTRACTS.md §5.8 plus additional edge cases.
// These tests are written FIRST (TDD).  Every test in this file must be green
// before any agent sync code is written.  That is the Gate 8 requirement.
//
// Run:  ctest -R test_fingerprint  (or ./test_fingerprint from the build dir)

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "sscope/fingerprint/fingerprint.h"

#include <limits>
#include <stdexcept>

using nlohmann::json;
using sscope::detail::serialize_number;
using sscope::detail::utf16_less;
using sscope::jcs_serialize;

// ── CT-NUM: ES2019 Number::toString ─────────────────────────────────────────
// Source: API_CONTRACTS.md §5.8, CT-NUM-01 through CT-NUM-09.

TEST(CtNum, CT_NUM_01_IntegerValuedDouble) {
    // 100.0 is integer-valued; must serialize as "100", not "100.0" or "1e2".
    EXPECT_EQ(serialize_number(100.0), "100");
}

TEST(CtNum, CT_NUM_02_SimpleFloat) {
    EXPECT_EQ(serialize_number(1.5), "1.5");
}

TEST(CtNum, CT_NUM_03_ShortestRoundTrip) {
    EXPECT_EQ(serialize_number(100.333), "100.333");
}

TEST(CtNum, CT_NUM_04_LargeIntegerValued) {
    EXPECT_EQ(serialize_number(1500.0), "1500");
}

TEST(CtNum, CT_NUM_05_LargeFloat) {
    EXPECT_EQ(serialize_number(1500.3), "1500.3");
}

TEST(CtNum, CT_NUM_06_LargeFloatWithFraction) {
    EXPECT_EQ(serialize_number(4294967296.5), "4294967296.5");
}

TEST(CtNum, CT_NUM_07_MaxMeasurement_NeverScientific) {
    // 1e15 = 1000000000000000.  ES2019 requires fixed notation for |v| < 10^21.
    // std::to_chars general may emit "1e+15" — Ryu must give the full decimal.
    EXPECT_EQ(serialize_number(1e15), "1000000000000000");
}

TEST(CtNum, CT_NUM_08_NegativeZero) {
    // ES2019: Number(-0).toString() == "0".  std::to_chars may emit "-0".
    EXPECT_EQ(serialize_number(-0.0), "0");
}

TEST(CtNum, CT_NUM_09_ZeroPointOne) {
    EXPECT_EQ(serialize_number(0.1), "0.1");
}

// ── Additional number edge cases ─────────────────────────────────────────────

TEST(CtNumExtra, PositiveZero) {
    EXPECT_EQ(serialize_number(0.0), "0");
}

TEST(CtNumExtra, NegativeIntegerValued) {
    // Negative integer-valued double: must include the minus sign.
    EXPECT_EQ(serialize_number(-42.0), "-42");
}

TEST(CtNumExtra, MaxSafeInteger) {
    // 2^53 - 1 = 9007199254740991; integer-valued.
    EXPECT_EQ(serialize_number(9007199254740991.0), "9007199254740991");
}

TEST(CtNumExtra, JustBeyondMaxSafeInteger) {
    // 2^53 = 9007199254740992.0; still integer-valued but treated as Ryu float
    // since it equals floor(v) and abs(v) == 9007199254740992.0 exactly.
    // Accept either "9007199254740992" (if classified as integer) or Ryu output.
    // Must not contain a decimal point or exponent for integer-valued inputs.
    std::string s = serialize_number(9007199254740992.0);
    EXPECT_EQ(s.find('.'), std::string::npos) << "unexpected decimal: " << s;
    EXPECT_EQ(s.find('e'), std::string::npos) << "unexpected exponent: " << s;
}

TEST(CtNumExtra, SmallPositiveFloat) {
    // 1e-6 is at the boundary of ES2019 fixed-vs-scientific: ES2019 uses fixed
    // for -6 <= exponent <= 21. 1e-6 has exponent -6 so it's "0.000001".
    EXPECT_EQ(serialize_number(1e-6), "0.000001");
}

// ── Negative tests: NaN and Infinity must throw ──────────────────────────────
// RFC 8785 §3.2.2.3: NaN and Infinity are not representable in JSON.
// The serializer must reject them with std::invalid_argument rather than
// silently emitting "null", which would produce a corrupt fingerprint.

TEST(SerializeNumberInvalid, ThrowsOnQuietNaN) {
    EXPECT_THROW(
        serialize_number(std::numeric_limits<double>::quiet_NaN()),
        std::invalid_argument);
}

TEST(SerializeNumberInvalid, ThrowsOnSignalingNaN) {
    EXPECT_THROW(
        serialize_number(std::numeric_limits<double>::signaling_NaN()),
        std::invalid_argument);
}

TEST(SerializeNumberInvalid, ThrowsOnPositiveInfinity) {
    EXPECT_THROW(
        serialize_number(std::numeric_limits<double>::infinity()),
        std::invalid_argument);
}

TEST(SerializeNumberInvalid, ThrowsOnNegativeInfinity) {
    EXPECT_THROW(
        serialize_number(-std::numeric_limits<double>::infinity()),
        std::invalid_argument);
}

TEST(JcsSerializeInvalid, ThrowsWhenObjectContainsNaN) {
    // nlohmann::json stores a NaN double as number_float; our serializer
    // must throw rather than silently emit "null" for the field value.
    json obj = json::object();
    // nlohmann allows constructing a json number from NaN by design.
    obj["bad"] = std::numeric_limits<double>::quiet_NaN();
    EXPECT_THROW(jcs_serialize(obj), std::invalid_argument);
}

TEST(JcsSerializeInvalid, ThrowsWhenArrayContainsInfinity) {
    json arr = json::array({1.0, std::numeric_limits<double>::infinity(), 2.0});
    EXPECT_THROW(jcs_serialize(arr), std::invalid_argument);
}

// ── CT-RFC8785: Key ordering and string escaping ─────────────────────────────
// Source: API_CONTRACTS.md §5.8, CT-RFC8785-01 through CT-RFC8785-04.

TEST(CtRfc8785, CT_RFC8785_01_BasicKeyOrdering) {
    // {"é": 1, "a": 2, "Z": 3} → code points: Z=0x5A < a=0x61 < é=0xE9.
    // All BMP, so UTF-16 order == code point order.
    json obj = json::object();
    obj["\xC3\xA9"] = 1;  // é (U+00E9, UTF-8: 0xC3 0xA9)
    obj["a"] = 2;
    obj["Z"] = 3;
    EXPECT_EQ(jcs_serialize(obj), "{\"Z\":3,\"a\":2,\"\xC3\xA9\":1}");
}

TEST(CtRfc8785, CT_RFC8785_02_NullByteEscape) {
    // A string containing U+0000 must emit \u0000 in the output.
    json obj = json::object();
    obj["k"] = std::string(1, '\0');  // string containing null byte
    std::string result = jcs_serialize(obj);
    EXPECT_NE(result.find("\\u0000"), std::string::npos)
        << "null byte must be escaped as \\u0000, got: " << result;
}

TEST(CtRfc8785, CT_RFC8785_03_StringEscaping) {
    // say "hello"\world → JSON-encoded as "say \"hello\"\\world"
    json obj = json::object();
    obj["k"] = "say \"hello\"\\world";
    // The JCS output for the value should be "say \"hello\"\\world"
    std::string result = jcs_serialize(obj);
    EXPECT_NE(result.find("say \\\"hello\\\"\\\\world"), std::string::npos)
        << "got: " << result;
}

TEST(CtRfc8785, CT_RFC8785_04_SupplementaryPlaneKeyOrdering) {
    // Object with keys U+E000 (BMP private use: UTF-8 0xEE 0x80 0x80) and
    // U+10000 (supplementary: UTF-8 0xF0 0x90 0x80 0x80, "𐀀").
    //
    // UTF-16 code unit order: U+10000 high surrogate = 0xD800 = 55296,
    // which is LESS than U+E000 = 57344.  So U+10000 ("𐀀") sorts FIRST.
    //
    // Expected canonical output: {"𐀀":2,"<U+E000>":1}
    // where <U+E000> is the three-byte UTF-8 sequence 0xEE 0x80 0x80.
    //
    // This REVERSES Unicode code-point order (U+E000 < U+10000 in code points).
    // Any implementation using code-point comparison will fail this test.

    std::string key_e000   = "\xEE\x80\x80";          // U+E000 in UTF-8
    std::string key_10000  = "\xF0\x90\x80\x80";      // U+10000 (𐀀) in UTF-8

    json obj = json::object();
    obj[key_e000]  = 1;
    obj[key_10000] = 2;

    std::string result = jcs_serialize(obj);

    // The supplementary-plane key (𐀀, U+10000) must appear BEFORE U+E000.
    size_t pos_10000 = result.find(key_10000);
    size_t pos_e000  = result.find(key_e000);

    ASSERT_NE(pos_10000, std::string::npos) << "U+10000 key missing from output";
    ASSERT_NE(pos_e000,  std::string::npos) << "U+E000 key missing from output";

    EXPECT_LT(pos_10000, pos_e000)
        << "U+10000 must sort BEFORE U+E000 in UTF-16 code unit order.\n"
        << "Got: " << result << "\n"
        << "This indicates code-point comparison instead of UTF-16 comparison.";
}

// ── utf16_less unit tests ────────────────────────────────────────────────────

TEST(Utf16Less, AsciiOrdering) {
    // Basic ASCII: "Z" < "a" < "é" in code-point order = UTF-16 order.
    EXPECT_TRUE(utf16_less("Z", "a"));
    EXPECT_TRUE(utf16_less("a", "\xC3\xA9"));  // "a" < é
    EXPECT_FALSE(utf16_less("a", "Z"));
}

TEST(Utf16Less, SameString) {
    EXPECT_FALSE(utf16_less("abc", "abc"));
}

TEST(Utf16Less, SupplementaryBeforeBmpAboveD7FF) {
    // Key point: U+10000 high surrogate 0xD800 < U+E000.
    std::string key_e000  = "\xEE\x80\x80";    // U+E000
    std::string key_10000 = "\xF0\x90\x80\x80"; // U+10000
    EXPECT_TRUE(utf16_less(key_10000, key_e000))
        << "U+10000 (high surrogate 0xD800=55296) must sort before U+E000 (57344)";
    EXPECT_FALSE(utf16_less(key_e000, key_10000));
}

TEST(Utf16Less, BmpPrivateUseOrdering) {
    // U+E000 < U+E001 in both code-point and UTF-16 order.
    std::string key_e000 = "\xEE\x80\x80";
    std::string key_e001 = "\xEE\x80\x81";
    EXPECT_TRUE(utf16_less(key_e000, key_e001));
}

// ── JCS serializer: structure tests ─────────────────────────────────────────

TEST(JcsSerialize, NullValue) {
    EXPECT_EQ(jcs_serialize(nullptr), "null");
}

TEST(JcsSerialize, BoolTrue) {
    EXPECT_EQ(jcs_serialize(true), "true");
}

TEST(JcsSerialize, BoolFalse) {
    EXPECT_EQ(jcs_serialize(false), "false");
}

TEST(JcsSerialize, Integer) {
    EXPECT_EQ(jcs_serialize(42), "42");
}

TEST(JcsSerialize, String) {
    EXPECT_EQ(jcs_serialize("hello"), "\"hello\"");
}

TEST(JcsSerialize, EmptyArray) {
    EXPECT_EQ(jcs_serialize(json::array()), "[]");
}

TEST(JcsSerialize, EmptyObject) {
    EXPECT_EQ(jcs_serialize(json::object()), "{}");
}

TEST(JcsSerialize, NestedObject) {
    json obj;
    obj["b"] = 2;
    obj["a"] = 1;
    // Keys must be sorted: "a" before "b".
    EXPECT_EQ(jcs_serialize(obj), "{\"a\":1,\"b\":2}");
}

TEST(JcsSerialize, ArrayPreservesOrder) {
    json arr = {3, 1, 2};
    EXPECT_EQ(jcs_serialize(arr), "[3,1,2]");
}

TEST(JcsSerialize, NoWhitespace) {
    json obj;
    obj["key"] = "value";
    std::string result = jcs_serialize(obj);
    for (char c : result) {
        EXPECT_NE(c, ' ')  << "space in output: " << result;
        EXPECT_NE(c, '\n') << "newline in output: " << result;
        EXPECT_NE(c, '\t') << "tab in output: " << result;
    }
}

TEST(JcsSerialize, NullFieldExplicit) {
    // Null fields in the measurements object must appear as explicit null,
    // never be omitted.  This matters for fingerprint determinism (§7.1 rule).
    json row;
    row["real_time_ns"]    = 123.456;
    row["cpu_time_ns"]     = nullptr;
    row["aggregate_name"]  = nullptr;
    row["bytes_per_second"]= nullptr;
    row["items_per_second"]= nullptr;
    row["unknown_fields"]  = nullptr;

    std::string result = jcs_serialize(row);
    // All null fields must appear as "null" in the output.
    EXPECT_NE(result.find("\"cpu_time_ns\":null"), std::string::npos)
        << "cpu_time_ns null must appear explicitly";
    EXPECT_NE(result.find("\"aggregate_name\":null"), std::string::npos)
        << "aggregate_name null must appear explicitly";
}

TEST(JcsSerialize, ImportEnvironmentNullInCanonicalF) {
    // For synthetic sessions, import_environment is null.
    // It must appear as a key with value null in canonical F — never omitted.
    json F;
    F["import_environment"] = nullptr;
    F["run_name"] = "test";

    std::string result = jcs_serialize(F);
    EXPECT_NE(result.find("\"import_environment\":null"), std::string::npos)
        << "import_environment:null must appear in canonical F";
}

// ── CT-CROSS-01 placeholder ──────────────────────────────────────────────────
// Full CT-CROSS-01 requires the TypeScript backend to be implemented.
// This test verifies the C++ side produces a stable, non-empty fingerprint
// for a known fixture.  The hex value here will be updated once the TypeScript
// reference confirms the expected output.

TEST(CtCross, CT_CROSS_01_StableFingerprintForKnownFixture) {
    // Minimal canonical object F with all edge-case values embedded.
    json F;
    F["build_config"]       = nullptr;
    F["build_type"]         = "Release";
    F["cpu_name"]           = "Test CPU";
    F["git_sha"]            = nullptr;
    F["import_environment"] = nullptr;
    F["import_timestamp"]   = "2026-11-02T00:00:00Z";
    F["isa"]                = "arm64";
    F["os_name"]            = "macOS";
    F["os_version"]         = "14.0.0";
    F["run_name"]           = "ct_cross_01";
    F["source"]             = "synthetic";
    F["source_marker"]      = nullptr;
    F["v"]                  = 1;

    // Embed CT-NUM edge cases as measurement values.
    json raw_row;
    raw_row["real_time_ns"]     = 100.0;    // CT-NUM-01: must serialize as "100"
    raw_row["cpu_time_ns"]      = nullptr;
    raw_row["iterations"]       = 30;
    raw_row["aggregate_name"]   = nullptr;
    raw_row["bytes_per_second"] = 1e15;     // CT-NUM-07: "1000000000000000"
    raw_row["items_per_second"] = -0.0;     // CT-NUM-08: "0"
    raw_row["unknown_fields"]   = nullptr;

    json measurements;
    measurements["raw_rows"]       = json::array({raw_row});
    measurements["aggregate_rows"] = json::array();

    json benchmark_case;
    benchmark_case["canonical_name"] = "BM_test";
    benchmark_case["data_type"]      = "raw_samples_available";
    benchmark_case["measurements"]   = measurements;
    benchmark_case["project_name"]   = "default";

    F["cases"] = json::array({benchmark_case});

    std::string fp = sscope::jcs_sha256_hex(F);

    // Must be exactly 64 lowercase hex characters.
    ASSERT_EQ(fp.size(), 64u);
    for (char c : fp) {
        EXPECT_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
            << "non-hex character in fingerprint: " << c;
    }

    // Determinism: same input must produce the same fingerprint on every call.
    EXPECT_EQ(fp, sscope::jcs_sha256_hex(F));

    // Cross-implementation check: verified against json-canonicalize (npm) on 2026-11-02.
    // C++ canonical output and Node.js canonical output are byte-for-byte identical.
    EXPECT_EQ(fp, "cc25b71af30e5d79e24d6c68606d34e826c09807b3fea27a6a19200a7326cdca");
}

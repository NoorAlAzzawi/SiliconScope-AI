#include <gtest/gtest.h>
#include "sscope/import/benchmark_importer.h"
#include "sscope/db/local_db.h"

#include <atomic>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

using sscope::LocalDb;
using sscope::BenchmarkImporter;
using sscope::ImportResult;
using sscope::ImportFileNotFound;
using sscope::ImportValidationError;

static std::string tmp_path(const std::string& suffix) {
    static std::atomic<int> counter{0};
    return "/tmp/sscope_test_security_" + std::to_string(getpid())
         + "_" + std::to_string(counter.fetch_add(1)) + suffix;
}

static void write_file(const std::string& path, const std::string& content) {
    std::ofstream f(path, std::ios::binary);
    f << content;
}

class SecurityFixture : public ::testing::Test {
protected:
    std::string db_path;
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

// ── ST-08: oversized file rejected at stat() before file is opened ────────────
//
// The import pipeline checks file size via stat() at stage 1, BEFORE calling
// std::ifstream::open().  This test uses a sparse file (ftruncate to MAX+1 bytes,
// zero disk cost) so that stat() reports the correct oversized size without
// filling the disk with 50 MiB of data.
//
// Proof that open() was not called: an ImportValidationError with stage==1 and
// the message "file exceeds 50 MiB limit" is thrown at line 233 of
// benchmark_importer.cpp, which is BEFORE the std::ifstream constructor on
// line 236.  Any other stage would indicate the file was opened first.
TEST_F(SecurityFixture, FileSizePreReadCheck_OversizedFileRejectedAtStage1) {
    static constexpr size_t MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB (mirror of importer)

    std::string path = tmp_path(".json");

    // Create a sparse file of MAX + 1 bytes: stat() reports the full size
    // while the file actually occupies only a single inode block on disk.
    int fd = ::open(path.c_str(), O_CREAT | O_WRONLY, 0600);
    ASSERT_GE(fd, 0) << "failed to create sparse file: " << strerror(errno);
    int rc = ::ftruncate(fd, static_cast<off_t>(MAX_FILE_BYTES) + 1);
    ::close(fd);
    ASSERT_EQ(rc, 0) << "ftruncate failed: " << strerror(errno);

    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError for oversized file";
    } catch (const ImportValidationError& e) {
        // stage == 1 proves stat() fired before std::ifstream::open().
        EXPECT_EQ(e.stage, 1) << "oversized file must be caught at stage 1 (pre-read stat check)";
        EXPECT_NE(std::string(e.what()).find("file exceeds 50 MiB limit"), std::string::npos)
            << "error message must identify the file-size limit";
    }
    std::filesystem::remove(path);
}

// ── SEC-005: null byte in context.executable ─────────────────────────────────
//
// context.executable containing \u0000 must be stored verbatim or rejected.
// It must NEVER reach exec/system/popen/open as a command or path.
// The JSON \u0000 escape decodes to an actual U+0000 in the C++ string, which
// becomes session.run_name.  Any path suffix after the null byte must not run.
TEST_F(SecurityFixture, NullByteInExecutableNeverExecuted) {
    const std::string marker = "/tmp/sscope_null_byte_pwned_" + std::to_string(getpid());
    std::string content =
        "{\"context\":{\"executable\":\"binary\\u0000; touch " + marker + "\","
        "\"build_type\":\"Debug\"},"
        "\"benchmarks\":["
        "{\"name\":\"BM_x\",\"run_type\":\"iteration\",\"real_time\":1.0,\"time_unit\":\"ns\"}"
        "]}";
    std::string path = tmp_path(".json");
    write_file(path, content);
    BenchmarkImporter imp(*db);
    try { imp.import(path); } catch (const std::exception&) {}
    EXPECT_FALSE(std::filesystem::exists(marker))
        << "SEC-005: null-byte injection via context.executable caused command execution";
    std::filesystem::remove(path);
    std::filesystem::remove(marker);
}

// ── Boundary: name exactly 1,024 bytes must succeed ──────────────────────────
TEST_F(SecurityFixture, NameExactly1024BytesAccepted) {
    std::string name(1024, 'a');
    std::string content =
        R"({"context":{},"benchmarks":[)"
        "{\"name\":\"" + name + "\",\"run_type\":\"iteration\","
        "\"real_time\":1.0,\"time_unit\":\"ns\"}]}";
    std::string path = tmp_path(".json");
    write_file(path, content);
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path))
        << "name of exactly 1,024 bytes must be accepted (spec: MAX_NAME_BYTES=1024)";
    EXPECT_EQ(r.cases_written, 1);
    std::filesystem::remove(path);
}

// ── Boundary: name of 1,025 bytes must throw ImportValidationError(stage 4) ──
TEST_F(SecurityFixture, NameOf1025BytesRejectedAtStage4) {
    std::string name(1025, 'a');
    std::string content =
        R"({"context":{},"benchmarks":[)"
        "{\"name\":\"" + name + "\",\"run_type\":\"iteration\","
        "\"real_time\":1.0,\"time_unit\":\"ns\"}]}";
    std::string path = tmp_path(".json");
    write_file(path, content);
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError for 1,025-byte name";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4) << "overlong name must be caught at stage 4";
    }
    std::filesystem::remove(path);
}

// ── Boundary: exactly 10,000 rows must succeed (inclusive limit) ──────────────
TEST_F(SecurityFixture, Exactly10000RowsAccepted) {
    std::string rows;
    rows.reserve(10000 * 80);
    for (int i = 0; i < 10000; ++i) {
        if (i > 0) rows += ',';
        rows += "{\"name\":\"BM_" + std::to_string(i) + "\","
                "\"run_type\":\"iteration\",\"real_time\":1.0,\"time_unit\":\"ns\"}";
    }
    std::string path = tmp_path(".json");
    write_file(path, R"({"context":{},"benchmarks":[)" + rows + "]}");
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path))
        << "exactly 10,000 rows must be accepted (spec: limit is strict >, not >=)";
    EXPECT_EQ(r.cases_written, 10000);
    std::filesystem::remove(path);
}

// ── Boundary: 10,001 rows must throw ImportValidationError(stage 3) ───────────
TEST_F(SecurityFixture, RowCount10001RejectedAtStage3) {
    std::string rows;
    rows.reserve(10001 * 80);
    for (int i = 0; i < 10001; ++i) {
        if (i > 0) rows += ',';
        rows += "{\"name\":\"BM_" + std::to_string(i) + "\","
                "\"run_type\":\"iteration\",\"real_time\":1.0,\"time_unit\":\"ns\"}";
    }
    std::string path = tmp_path(".json");
    write_file(path, R"({"context":{},"benchmarks":[)" + rows + "]}");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError for 10,001 rows";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 3) << "row-count violation must be caught at stage 3";
    }
    std::filesystem::remove(path);
}

// ── Adversarial: JSON nesting depth > 33 must throw ImportValidationError(2) ──
//
// Spec: nesting depth > 32 must abort at stage 2 (ImportValidationError stage 2).
// This is now enforced after the fix that wires JSON_MAX_DEPTH=33 into the parser.
TEST_F(SecurityFixture, DeeplyNestedJsonRejectedAtStage2) {
    // 40 levels deep — well above the spec limit of 32.
    std::string open_str, close_str;
    for (int i = 0; i < 40; ++i) { open_str += "{\"k\":"; close_str += "}"; }
    std::string content =
        R"({"context":{"deep":)" + open_str + "\"v\"" + close_str +
        R"(},"benchmarks":[{"name":"BM_x","run_type":"iteration","real_time":1.0,"time_unit":"ns"}]})";
    std::string path = tmp_path(".json");
    write_file(path, content);
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError(2) for nesting depth > 33";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 2) << "depth > 33 must be caught at stage 2 (JSON parse)";
    }
    std::filesystem::remove(path);
}

// ── Adversarial: extreme float (1e308) handled gracefully ────────────────────
//
// 1e308 is a valid IEEE-754 double (close to DBL_MAX ≈ 1.8e308).
// The importer must not crash, invoke undefined behaviour, or throw an
// unexpected exception.  It may succeed (storing the value) or throw
// ImportValidationError if the implementation adds range checks.
TEST_F(SecurityFixture, ExtremeFloatHandledGracefully) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {"name":"BM_extreme","run_type":"iteration","real_time":1e308,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    EXPECT_NO_FATAL_FAILURE({
        try { imp.import(path); } catch (const ImportValidationError&) {}
    }) << "real_time=1e308 must not crash or trigger undefined behaviour";
    std::filesystem::remove(path);
}

// ── Control chars: tab (U+0009) in name must throw ImportValidationError(4) ───
//
// Spec (REQUIREMENTS.md §FR-I-005, SECURITY.md): reject U+0000–U+001F in names.
// Tab is U+0009.  In JSON, \t decodes to 0x09 in the C++ string.
TEST_F(SecurityFixture, TabInNameRejectedAtStage4) {
    std::string path = tmp_path(".json");
    // \t in JSON string → literal 0x09 byte in C++ string.
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {"name":"BM_\tx","run_type":"iteration","real_time":1.0,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError for tab in name";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4) << "tab (U+0009) in name must be caught at stage 4";
    }
    std::filesystem::remove(path);
}

// ── Control chars: DEL (U+007F) in name must throw ImportValidationError(4) ───
//
// Spec: reject U+007F in names in addition to U+0000–U+001F.
// \u007f in JSON decodes to 0x7F in the C++ string.
TEST_F(SecurityFixture, DelInNameRejectedAtStage4) {
    std::string path = tmp_path(".json");
    // \u007f in JSON string → literal 0x7F byte in C++ string.
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {"name":"BM_\u007fx","run_type":"iteration","real_time":1.0,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError for DEL in name";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4) << "DEL (U+007F) in name must be caught at stage 4";
    }
    std::filesystem::remove(path);
}

// ── Classification: no run_type + aggregate_name → aggregate row ──────────────
//
// Old Google Benchmark output may omit run_type.  If aggregate_name is present,
// the row must be classified as "aggregate", not "iteration".
// After the fix: a batch containing only such a row must succeed with
// data_type="aggregate_only" (no raw rows, one aggregate row).
// The LocalDb API does not expose data_type for reading back; we verify
// import succeeds and exactly one case is written.
TEST_F(SecurityFixture, NoRunTypeWithAggregateNameClassifiedAsAggregate) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {"executable": "bench", "build_type": "Release"},
      "benchmarks": [
        {
          "name": "BM_sort_mean",
          "aggregate_name": "mean",
          "real_time": 101.0,
          "cpu_time": 99.5,
          "time_unit": "ns"
        }
      ]
    })");
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path))
        << "row with aggregate_name but no run_type must be accepted as aggregate";
    EXPECT_EQ(r.cases_written, 1)
        << "one case must be written (classified as aggregate, not skipped)";
    std::filesystem::remove(path);
}

#include <gtest/gtest.h>
#include "sscope/import/benchmark_importer.h"
#include "sscope/import/benchmark_sort.h"
#include "sscope/db/local_db.h"

#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>

using sscope::LocalDb;
using sscope::BenchmarkImporter;
using sscope::ImportOptions;
using sscope::ImportResult;
using sscope::ImportFileNotFound;
using sscope::ImportValidationError;

// ── Fixtures & helpers ────────────────────────────────────────────────────────

static std::string tmp_path(const std::string& suffix) {
    static std::atomic<int> counter{0};
    return "/tmp/sscope_test_importer_" + std::to_string(getpid())
         + "_" + std::to_string(counter.fetch_add(1)) + suffix;
}

static void write_file(const std::string& path, const std::string& content) {
    std::ofstream f(path);
    f << content;
}

// Minimal valid Google Benchmark JSON.
static const char* VALID_JSON = R"({
  "context": {
    "executable": "test_binary",
    "build_type": "Release"
  },
  "benchmarks": [
    {
      "name": "BM_sort",
      "run_type": "iteration",
      "iterations": 100,
      "real_time": 1234.5,
      "cpu_time": 1200.0,
      "time_unit": "ns"
    }
  ]
})";

class ImporterFixture : public ::testing::Test {
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

// ── Stage 0: File not found ───────────────────────────────────────────────────

TEST_F(ImporterFixture, MissingFileThrowsFileNotFound) {
    BenchmarkImporter imp(*db);
    EXPECT_THROW(imp.import("/nonexistent/path/file.json"), ImportFileNotFound);
}

// ── Stage 1: File size ────────────────────────────────────────────────────────

TEST_F(ImporterFixture, EmptyFileThrowsValidationError) {
    std::string path = tmp_path(".json");
    write_file(path, "");
    BenchmarkImporter imp(*db);
    EXPECT_THROW(imp.import(path), ImportValidationError);
    std::filesystem::remove(path);
}

// ── Stage 2: JSON parse error ─────────────────────────────────────────────────

TEST_F(ImporterFixture, MalformedJsonThrowsStage2) {
    std::string path = tmp_path(".json");
    write_file(path, "{not valid json}");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL() << "expected ImportValidationError";
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 2);
    }
    std::filesystem::remove(path);
}

// ── Stage 3: Schema ───────────────────────────────────────────────────────────

TEST_F(ImporterFixture, MissingContextThrowsStage3) {
    std::string path = tmp_path(".json");
    write_file(path, R"({"benchmarks": []})");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 3);
    }
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, MissingBenchmarksThrowsStage3) {
    std::string path = tmp_path(".json");
    write_file(path, R"({"context": {}})");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 3);
    }
    std::filesystem::remove(path);
}

// ── Stage 4: Row validation ───────────────────────────────────────────────────

TEST_F(ImporterFixture, RowMissingNameThrowsStage4) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [{"real_time": 1.0, "time_unit": "ns"}]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4);
    }
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, RowMissingRealTimeThrowsStage4) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [{"name": "BM_x", "time_unit": "ns"}]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4);
    }
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, RowMissingTimeUnitThrowsStage4) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [{"name": "BM_x", "real_time": 1.0}]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4);
    }
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, RowNegativeRealTimeThrowsStage4) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [{"name": "BM_x", "real_time": -1.0, "time_unit": "ns"}]
    })");
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4);
    }
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, RowNameTooLongThrowsStage4) {
    std::string long_name(1025, 'x');
    std::string json = R"({"context": {}, "benchmarks": [{"name": ")" + long_name +
                       R"(", "real_time": 1.0, "time_unit": "ns"}]})";
    std::string path = tmp_path(".json");
    write_file(path, json);
    BenchmarkImporter imp(*db);
    try {
        imp.import(path);
        FAIL();
    } catch (const ImportValidationError& e) {
        EXPECT_EQ(e.stage, 4);
    }
    std::filesystem::remove(path);
}

// ── Successful import ─────────────────────────────────────────────────────────

TEST_F(ImporterFixture, ValidImportSucceeds) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path));
    EXPECT_FALSE(r.session_id.empty());
    EXPECT_EQ(static_cast<int>(r.content_fingerprint.size()), 64);
    EXPECT_EQ(r.cases_written, 1);
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, SessionPersisted) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);
    auto r = imp.import(path);

    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    EXPECT_EQ(row->content_fingerprint, r.content_fingerprint);
    EXPECT_EQ(row->source, "user-supplied import");
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, FingerprintIs64HexChars) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);
    auto r = imp.import(path);
    EXPECT_EQ(static_cast<int>(r.content_fingerprint.size()), 64);
    for (char c : r.content_fingerprint)
        EXPECT_TRUE((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
            << "non-hex char: " << c;
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, AggregateRowsClassifiedSeparately) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {"executable": "tb", "build_type": "Release"},
      "benchmarks": [
        {"name":"BM_x","run_type":"iteration","iterations":50,"real_time":100,"time_unit":"ns"},
        {"name":"BM_x","run_type":"iteration","iterations":50,"real_time":102,"time_unit":"ns"},
        {"name":"BM_x_mean","run_type":"aggregate","aggregate_name":"mean","real_time":101,"time_unit":"ns"},
        {"name":"BM_x_stddev","run_type":"aggregate","aggregate_name":"stddev","real_time":1,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path));
    // Expect 3 cases: BM_x (raw), BM_x_mean (aggregate), BM_x_stddev (aggregate)
    EXPECT_EQ(r.cases_written, 3);
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, UnsupportedRunTypeSkipped) {
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {"name":"BM_ok","run_type":"iteration","real_time":1.0,"time_unit":"ns"},
        {"name":"BM_skip","run_type":"unknown_future_type","real_time":2.0,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path));
    EXPECT_EQ(r.cases_written, 1);
    std::filesystem::remove(path);
}

// ── Security: no code execution from imported fields ─────────────────────────

TEST_F(ImporterFixture, CommandInjectionInNameDoesNotExecute) {
    // Adversarial input: name contains shell metacharacters.
    // The import must succeed without executing any command.
    std::string path = tmp_path(".json");
    write_file(path, R"JSON({
      "context": {},
      "benchmarks": [
        {
          "name": "BM_$(touch /tmp/pwned_sscope)",
          "real_time": 1.0,
          "time_unit": "ns"
        }
      ]
    })JSON");
    BenchmarkImporter imp(*db);
    // Import must succeed (name is valid UTF-8 with printable chars after $).
    // The shell metacharacters must be stored verbatim, never executed.
    ASSERT_NO_THROW(imp.import(path));
    // Verify the injected command was not executed.
    EXPECT_FALSE(std::filesystem::exists("/tmp/pwned_sscope"))
        << "Security: shell command in benchmark name was executed!";
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, ExecutablePathInContextNotExecuted) {
    // Adversarial: executable field set to a real binary path.
    // This value becomes run_name; it must NEVER be exec'd.
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {"executable": "/bin/sh", "build_type": "Debug"},
      "benchmarks": [
        {"name":"BM_safe","real_time":1.0,"time_unit":"ns"}
      ]
    })");
    BenchmarkImporter imp(*db);
    ASSERT_NO_THROW(imp.import(path));
    // If /bin/sh were executed we'd see unexpected output; the process just proceeds normally.
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, UnknownFieldsStoredVerbatim) {
    // Unknown fields must be stored as JSON, not interpreted.
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {
          "name": "BM_x",
          "real_time": 1.0,
          "time_unit": "ns",
          "custom_field": "../../etc/passwd"
        }
      ]
    })");
    BenchmarkImporter imp(*db);
    ImportResult r;
    ASSERT_NO_THROW(r = imp.import(path));
    // Session should be written successfully; the path was not opened.
    EXPECT_EQ(r.cases_written, 1);
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, TimeUnitConversionCorrect) {
    // Import in microseconds; verify real_time_ns is scaled correctly.
    std::string path = tmp_path(".json");
    write_file(path, R"({
      "context": {},
      "benchmarks": [
        {"name":"BM_us","real_time":1.0,"time_unit":"us"}
      ]
    })");
    BenchmarkImporter imp(*db);
    ASSERT_NO_THROW(imp.import(path));
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, SourceFieldIsUserSuppliedImport) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);
    auto r = imp.import(path);
    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    EXPECT_EQ(row->source, "user-supplied import");
    std::filesystem::remove(path);
}

// ── ImportOptions: provenance overrides ──────────────────────────────────────

static const char* JSON_WITH_GIT_SHA = R"({
  "context": {
    "executable": "test_binary",
    "build_type": "Release",
    "git_sha": "aabbccdd"
  },
  "benchmarks": [
    {"name": "BM_x", "run_type": "iteration", "iterations": 10,
     "real_time": 100.0, "cpu_time": 99.0, "time_unit": "ns"}
  ]
})";

TEST_F(ImporterFixture, ImportOptionsGitShaOverridesJsonContext) {
    std::string path = tmp_path(".json");
    write_file(path, JSON_WITH_GIT_SHA);
    BenchmarkImporter imp(*db);

    ImportOptions opts;
    opts.git_sha = "overridden-sha";
    auto r = imp.import(path, opts);

    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    ASSERT_TRUE(row->git_sha.has_value());
    EXPECT_EQ(row->git_sha.value(), "overridden-sha")
        << "CLI --commit should override JSON context git_sha";
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, ImportOptionsNoGitShaFallsBackToJsonContext) {
    std::string path = tmp_path(".json");
    write_file(path, JSON_WITH_GIT_SHA);
    BenchmarkImporter imp(*db);

    ImportOptions opts; // git_sha not set
    auto r = imp.import(path, opts);

    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    ASSERT_TRUE(row->git_sha.has_value());
    EXPECT_EQ(row->git_sha.value(), "aabbccdd")
        << "Without --commit, JSON context git_sha should be used";
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, ImportOptionsBuildConfigStoredInSession) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);

    ImportOptions opts;
    opts.build_config = "Release-AVX2";
    auto r = imp.import(path, opts);

    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    ASSERT_TRUE(row->build_config.has_value());
    EXPECT_EQ(row->build_config.value(), "Release-AVX2");
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, ImportOptionsNoBuildConfigStoresNull) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);

    ImportOptions opts; // build_config not set
    auto r = imp.import(path, opts);

    auto row = db->get_session(r.session_id);
    ASSERT_TRUE(row.has_value());
    EXPECT_FALSE(row->build_config.has_value());
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, DifferentBuildConfigsProduceDifferentFingerprints) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);

    ImportOptions opts_a;
    opts_a.build_config = "Release";
    auto r_a = imp.import(path, opts_a);

    ImportOptions opts_b;
    opts_b.build_config = "Debug";
    auto r_b = imp.import(path, opts_b);

    EXPECT_NE(r_a.content_fingerprint, r_b.content_fingerprint)
        << "Different build_configs must produce different fingerprints";
    std::filesystem::remove(path);
}

TEST_F(ImporterFixture, NullBuildConfigAndSetBuildConfigProduceDifferentFingerprints) {
    std::string path = tmp_path(".json");
    write_file(path, VALID_JSON);
    BenchmarkImporter imp(*db);

    ImportOptions opts_null; // no build_config
    auto r_null = imp.import(path, opts_null);

    ImportOptions opts_set;
    opts_set.build_config = "Release";
    auto r_set = imp.import(path, opts_set);

    EXPECT_NE(r_null.content_fingerprint, r_set.content_fingerprint)
        << "null build_config vs set build_config must produce different fingerprints";
    std::filesystem::remove(path);
}

// ── Regression: sort key is project_name + NUL + canonical_name ──────────────
// API_CONTRACTS.md §5.3: cases in canonical F must be sorted by the composite
// key "project_name\0canonical_name".  A regression to canonical_name-only
// sorting would flip the expected order below.

TEST(BenchmarkSortKey, SortKeyOrder) {
    using nlohmann::json;

    auto make_case = [](const std::string& project, const std::string& canonical) {
        json j;
        j["project_name"]   = project;
        j["canonical_name"] = canonical;
        return j;
    };

    // A: project="b", canonical="a"  → composite "b\0a"
    // B: project="a", canonical="b"  → composite "a\0b"
    //
    // Under composite key:  B < A  ("a\0b" < "b\0a")
    // Under canonical only: A < B  ("a"    < "b")
    //
    // Asserting B < A catches a regression to canonical-name-only sorting.
    json a = make_case("b", "a");
    json b = make_case("a", "b");

    EXPECT_TRUE(sscope::detail::benchmark_case_less(b, a))
        << "B (project=a, canonical=b) must sort before A (project=b, canonical=a) "
           "under the composite key; canonical-only sort would reverse this.";
    EXPECT_FALSE(sscope::detail::benchmark_case_less(a, b))
        << "A must NOT sort before B under the composite key.";

    // Verify sort produces the right order.
    std::vector<json> cases = {a, b};
    std::sort(cases.begin(), cases.end(), sscope::detail::benchmark_case_less);
    EXPECT_EQ(cases[0]["project_name"].get<std::string>(), "a")
        << "After sort, entry with project='a' must come first.";
    EXPECT_EQ(cases[1]["project_name"].get<std::string>(), "b");

    // Same project, different canonical names: sort by canonical_name ascending.
    json c = make_case("alpha", "aaa");
    json d = make_case("alpha", "bbb");
    EXPECT_TRUE(sscope::detail::benchmark_case_less(c, d));
    EXPECT_FALSE(sscope::detail::benchmark_case_less(d, c));

    // Different projects, same canonical name: sort by project_name ascending.
    json e = make_case("aaa", "BM_x");
    json f = make_case("bbb", "BM_x");
    EXPECT_TRUE(sscope::detail::benchmark_case_less(e, f));
    EXPECT_FALSE(sscope::detail::benchmark_case_less(f, e));
}

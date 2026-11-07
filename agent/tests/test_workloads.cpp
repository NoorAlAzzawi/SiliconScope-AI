#include <gtest/gtest.h>
#include "sscope/workloads/utils.h"

#include <cmath>
#include <limits>

namespace sscope {
WorkloadResult run_cpu_integer();
WorkloadResult run_cpu_float();
} // namespace sscope

using sscope::WorkloadResult;
using sscope::compute_stats;

// ── compute_stats ─────────────────────────────────────────────────────────────

TEST(ComputeStats, SingleSample) {
    auto s = compute_stats({42.0});
    EXPECT_DOUBLE_EQ(s.mean_ns,   42.0);
    EXPECT_DOUBLE_EQ(s.median_ns, 42.0);
    EXPECT_DOUBLE_EQ(s.min_ns,    42.0);
    EXPECT_DOUBLE_EQ(s.max_ns,    42.0);
    EXPECT_DOUBLE_EQ(s.stddev_ns, 0.0);
}

TEST(ComputeStats, TwoSamples) {
    auto s = compute_stats({10.0, 20.0});
    EXPECT_DOUBLE_EQ(s.mean_ns,   15.0);
    EXPECT_DOUBLE_EQ(s.median_ns, 15.0);
    EXPECT_DOUBLE_EQ(s.min_ns,    10.0);
    EXPECT_DOUBLE_EQ(s.max_ns,    20.0);
}

TEST(ComputeStats, OddCountMedian) {
    // {1, 3, 5}: median = 3
    auto s = compute_stats({5.0, 1.0, 3.0});
    EXPECT_DOUBLE_EQ(s.median_ns, 3.0);
}

TEST(ComputeStats, EvenCountMedian) {
    // {1, 2, 3, 4}: median = 2.5
    auto s = compute_stats({3.0, 1.0, 4.0, 2.0});
    EXPECT_DOUBLE_EQ(s.median_ns, 2.5);
}

TEST(ComputeStats, Stddev) {
    // {0, 2, 4}: mean=2, deviations={-2, 0, 2}, pop-var=8/3, stddev=sqrt(8/3)
    auto s = compute_stats({0.0, 2.0, 4.0});
    EXPECT_NEAR(s.stddev_ns, std::sqrt(8.0 / 3.0), 1e-10);
}

TEST(ComputeStats, ThirtyUniformSamples) {
    std::vector<double> v(30, 100.0);
    auto s = compute_stats(v);
    EXPECT_DOUBLE_EQ(s.mean_ns,   100.0);
    EXPECT_DOUBLE_EQ(s.stddev_ns, 0.0);
    EXPECT_DOUBLE_EQ(s.min_ns,    100.0);
    EXPECT_DOUBLE_EQ(s.max_ns,    100.0);
}

// ── DoNotOptimize / ClobberMemory — just check they compile and don't crash ──

TEST(WorkloadUtils, DoNotOptimizeUint64) {
    uint64_t x = 42;
    sscope::DoNotOptimize(x);
    EXPECT_EQ(x, 42ULL);
}

TEST(WorkloadUtils, ClobberMemoryDoesNotCrash) {
    EXPECT_NO_THROW(sscope::ClobberMemory());
}

// ── cpu_integer workload ──────────────────────────────────────────────────────
// These are integration tests — they run the real workload briefly.
// Calibration ensures >= 10ms per iteration.

TEST(CpuIntegerWorkload, NameIsSet) {
    auto result = sscope::run_cpu_integer();
    EXPECT_EQ(result.benchmark_name, "BM_cpu_integer_lcg");
}

TEST(CpuIntegerWorkload, ProducesMeasurementCount) {
    auto result = sscope::run_cpu_integer();
    EXPECT_EQ(static_cast<int>(result.raw_rows.size()), sscope::MEASUREMENT_ITERATIONS);
}

TEST(CpuIntegerWorkload, AllTimingsPositive) {
    auto result = sscope::run_cpu_integer();
    for (auto& r : result.raw_rows)
        EXPECT_GT(r.real_time_ns, 0.0) << "non-positive timing";
}

TEST(CpuIntegerWorkload, StatsConsistentWithRows) {
    auto result = sscope::run_cpu_integer();
    EXPECT_GE(result.stats.max_ns, result.stats.min_ns);
    EXPECT_GE(result.stats.mean_ns, result.stats.min_ns);
    EXPECT_LE(result.stats.mean_ns, result.stats.max_ns);
    EXPECT_GE(result.stats.stddev_ns, 0.0);
}

TEST(CpuIntegerWorkload, IterationsPositive) {
    auto result = sscope::run_cpu_integer();
    for (auto& r : result.raw_rows)
        EXPECT_GT(r.iterations, 0ULL) << "zero iterations";
}

// ── cpu_float workload ────────────────────────────────────────────────────────

TEST(CpuFloatWorkload, NameIsSet) {
    auto result = sscope::run_cpu_float();
    EXPECT_EQ(result.benchmark_name, "BM_cpu_float_trig");
}

TEST(CpuFloatWorkload, ProducesMeasurementCount) {
    auto result = sscope::run_cpu_float();
    EXPECT_EQ(static_cast<int>(result.raw_rows.size()), sscope::MEASUREMENT_ITERATIONS);
}

TEST(CpuFloatWorkload, AllTimingsPositive) {
    auto result = sscope::run_cpu_float();
    for (auto& r : result.raw_rows)
        EXPECT_GT(r.real_time_ns, 0.0);
}

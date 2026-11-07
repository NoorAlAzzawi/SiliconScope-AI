#include <gtest/gtest.h>
#include "sscope/workloads/utils.h"

#include <cmath>
#include <numeric>

using sscope::compute_stats;
using sscope::AggregateStats;

// These tests exercise compute_stats in detail using analytically known values.

TEST(Statistics, MeanOfArithmSequence) {
    // {1, 2, ..., 100}: mean = 50.5
    std::vector<double> v(100);
    std::iota(v.begin(), v.end(), 1.0);
    auto s = compute_stats(v);
    EXPECT_NEAR(s.mean_ns, 50.5, 1e-9);
}

TEST(Statistics, MedianOdd) {
    auto s = compute_stats({7.0, 3.0, 1.0, 5.0, 9.0});
    EXPECT_DOUBLE_EQ(s.median_ns, 5.0);
}

TEST(Statistics, MedianEven) {
    auto s = compute_stats({4.0, 8.0, 1.0, 6.0});
    // sorted: {1, 4, 6, 8} → (4+6)/2 = 5
    EXPECT_DOUBLE_EQ(s.median_ns, 5.0);
}

TEST(Statistics, MinMaxIdentity) {
    auto s = compute_stats({99.0, 1.0, 50.0});
    EXPECT_DOUBLE_EQ(s.min_ns, 1.0);
    EXPECT_DOUBLE_EQ(s.max_ns, 99.0);
}

TEST(Statistics, PopulationStddev) {
    // {2, 4, 4, 4, 5, 5, 7, 9}: mean=5, pop-stddev=2
    auto s = compute_stats({2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0});
    EXPECT_NEAR(s.mean_ns,   5.0, 1e-10);
    EXPECT_NEAR(s.stddev_ns, 2.0, 1e-10);
}

TEST(Statistics, AllSameValues) {
    std::vector<double> v(30, 42.0);
    auto s = compute_stats(v);
    EXPECT_DOUBLE_EQ(s.mean_ns,   42.0);
    EXPECT_DOUBLE_EQ(s.median_ns, 42.0);
    EXPECT_DOUBLE_EQ(s.stddev_ns, 0.0);
    EXPECT_DOUBLE_EQ(s.min_ns,    42.0);
    EXPECT_DOUBLE_EQ(s.max_ns,    42.0);
}

TEST(Statistics, LargeValues) {
    // Nanoseconds: 1 second = 1e9 ns
    std::vector<double> v = {1.0e9, 2.0e9, 3.0e9};
    auto s = compute_stats(v);
    EXPECT_NEAR(s.mean_ns, 2.0e9, 1.0);
}

TEST(Statistics, TwoElementsMeanMedian) {
    auto s = compute_stats({1.0, 3.0});
    EXPECT_DOUBLE_EQ(s.mean_ns,   2.0);
    EXPECT_DOUBLE_EQ(s.median_ns, 2.0);
}

TEST(Statistics, NegativeDoesNotOccurInPractice) {
    // Verify min/max work on a contrived set where all values differ.
    auto s = compute_stats({100.0, 200.0, 150.0, 50.0, 300.0});
    EXPECT_DOUBLE_EQ(s.min_ns, 50.0);
    EXPECT_DOUBLE_EQ(s.max_ns, 300.0);
}

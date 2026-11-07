#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace sscope {

// Prevent the compiler from optimizing away a value.
// The "+r,m" constraint forces the value into a register or memory location.
template <typename T>
inline void DoNotOptimize(T& value) {
    asm volatile("" : "+r,m"(value) : : "memory");
}

// Force the compiler to assume all memory may have changed.
inline void ClobberMemory() {
    asm volatile("" : : : "memory");
}

// One measurement row produced by a workload run.
struct MeasurementRow {
    double real_time_ns;              // wall-clock time per inner iteration
    double cpu_time_ns;               // CPU time per inner iteration (may equal real_time_ns)
    uint64_t iterations;              // N_inner used for this measurement
    double bytes_per_second;          // 0 if not applicable
    double items_per_second;          // 0 if not applicable
};

// Aggregate statistics computed over a set of real_time_ns samples.
struct AggregateStats {
    double mean_ns;
    double median_ns;
    double stddev_ns;
    double min_ns;
    double max_ns;
};

// Full result of running one workload.
struct WorkloadResult {
    std::string benchmark_name;
    std::vector<MeasurementRow> raw_rows;
    AggregateStats stats;
};

// Compute aggregate statistics over a vector of samples.
// Requires samples.size() >= 1.
inline AggregateStats compute_stats(std::vector<double> samples) {
    AggregateStats s{};
    if (samples.empty()) return s;

    double sum = 0.0;
    s.min_ns = samples[0];
    s.max_ns = samples[0];
    for (double v : samples) {
        sum += v;
        if (v < s.min_ns) s.min_ns = v;
        if (v > s.max_ns) s.max_ns = v;
    }
    s.mean_ns = sum / static_cast<double>(samples.size());

    // Population stddev over measurement samples.
    double sq_sum = 0.0;
    for (double v : samples) {
        double d = v - s.mean_ns;
        sq_sum += d * d;
    }
    s.stddev_ns = std::sqrt(sq_sum / static_cast<double>(samples.size()));

    // Median: sort a copy.
    std::sort(samples.begin(), samples.end());
    size_t n = samples.size();
    if (n % 2 == 0)
        s.median_ns = (samples[n / 2 - 1] + samples[n / 2]) / 2.0;
    else
        s.median_ns = samples[n / 2];

    return s;
}

// Calibrate the inner loop count so that one outer iteration takes >= min_ns.
// Returns the calibrated N_inner.
template <typename WorkFn>
uint64_t calibrate(WorkFn work, double min_ns = 10.0e6 /* 10ms */) {
    uint64_t n = 1;
    while (true) {
        auto t0 = std::chrono::high_resolution_clock::now();
        work(n);
        auto t1 = std::chrono::high_resolution_clock::now();
        double elapsed = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
        if (elapsed >= min_ns) return n;
        // Double n, but guard against overflow.
        if (n > UINT64_MAX / 2) return n;
        n *= 2;
    }
}

static constexpr int WARMUP_ITERATIONS     = 5;
static constexpr int MEASUREMENT_ITERATIONS = 30;

} // namespace sscope

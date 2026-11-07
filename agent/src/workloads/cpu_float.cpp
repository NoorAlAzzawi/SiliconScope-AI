#include "sscope/workloads/utils.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>

namespace sscope {

// Trigonometric chain: sin(cos(sin(...))), forces FP unit utilization.
static void run_fpu_chain(uint64_t n) {
    double x = 1.0;
    for (uint64_t i = 0; i < n; ++i) {
        x = std::sin(x + 0.001) + std::cos(x * 0.999);
        DoNotOptimize(x);
    }
    ClobberMemory();
}

WorkloadResult run_cpu_float() {
    uint64_t n_inner = calibrate([](uint64_t n) { run_fpu_chain(n); });

    for (int i = 0; i < WARMUP_ITERATIONS; ++i)
        run_fpu_chain(n_inner);

    std::vector<MeasurementRow> rows;
    rows.reserve(MEASUREMENT_ITERATIONS);
    for (int i = 0; i < MEASUREMENT_ITERATIONS; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        run_fpu_chain(n_inner);
        auto t1 = std::chrono::high_resolution_clock::now();
        double elapsed_ns = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
        double per_iter_ns = elapsed_ns / static_cast<double>(n_inner);
        rows.push_back({per_iter_ns, per_iter_ns, n_inner, 0.0, 0.0});
    }

    std::vector<double> samples;
    samples.reserve(rows.size());
    for (auto& r : rows) samples.push_back(r.real_time_ns);

    WorkloadResult res;
    res.benchmark_name = "BM_cpu_float_trig";
    res.raw_rows       = std::move(rows);
    res.stats          = compute_stats(std::move(samples));
    return res;
}

} // namespace sscope

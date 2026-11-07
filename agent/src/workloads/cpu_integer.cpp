#include "sscope/workloads/utils.h"

#include <chrono>
#include <cstdint>
#include <vector>

namespace sscope {

// Knuth multiplicative LCG — fast, register-resident, prevents loop elision.
static void run_lcg(uint64_t n) {
    uint64_t result = 0x123456789ABCDEF0ULL;
    for (uint64_t i = 0; i < n; ++i) {
        result = result * 6364136223846793005ULL + 1442695040888963407ULL;
        DoNotOptimize(result);
    }
    ClobberMemory();
}

WorkloadResult run_cpu_integer() {
    // Calibrate: find N_inner so one outer iteration takes >= 10ms.
    uint64_t n_inner = calibrate([](uint64_t n) { run_lcg(n); });

    // Warmup: discard timing, let branch predictors and caches settle.
    for (int i = 0; i < WARMUP_ITERATIONS; ++i)
        run_lcg(n_inner);

    // Measurement: 30 outer iterations.
    std::vector<MeasurementRow> rows;
    rows.reserve(MEASUREMENT_ITERATIONS);
    for (int i = 0; i < MEASUREMENT_ITERATIONS; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        run_lcg(n_inner);
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
    res.benchmark_name = "BM_cpu_integer_lcg";
    res.raw_rows       = std::move(rows);
    res.stats          = compute_stats(std::move(samples));
    return res;
}

} // namespace sscope

#include "sscope/workloads/utils.h"

#include <chrono>
#include <cstdint>
#include <numeric>
#include <vector>

namespace sscope {

static constexpr size_t RAND_BUFFER_ELEMS = 4 * 1024 * 1024; // 4M uint64_t = 32 MiB

// Chase a pointer chain to force cache misses.
static void run_random_access(uint64_t n) {
    // One-time build of a shuffled index array (Fisher-Yates with LCG).
    static std::vector<uint64_t> indices = []() {
        std::vector<uint64_t> v(RAND_BUFFER_ELEMS);
        std::iota(v.begin(), v.end(), 0ULL);
        uint64_t r = 0xDEADBEEFCAFEBABEULL;
        for (size_t i = RAND_BUFFER_ELEMS - 1; i > 0; --i) {
            r = r * 6364136223846793005ULL + 1442695040888963407ULL;
            size_t j = r % (i + 1);
            std::swap(v[i], v[j]);
        }
        return v;
    }();

    for (uint64_t iter = 0; iter < n; ++iter) {
        uint64_t idx = 0;
        for (size_t step = 0; step < 1024; ++step) {
            idx = indices[idx % RAND_BUFFER_ELEMS];
            DoNotOptimize(idx);
        }
    }
    ClobberMemory();
}

WorkloadResult run_memory_rand() {
    uint64_t n_inner = calibrate([](uint64_t n) { run_random_access(n); });

    for (int i = 0; i < WARMUP_ITERATIONS; ++i)
        run_random_access(n_inner);

    std::vector<MeasurementRow> rows;
    rows.reserve(MEASUREMENT_ITERATIONS);
    for (int i = 0; i < MEASUREMENT_ITERATIONS; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        run_random_access(n_inner);
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
    res.benchmark_name = "BM_memory_rand_chase";
    res.raw_rows       = std::move(rows);
    res.stats          = compute_stats(std::move(samples));
    return res;
}

} // namespace sscope

#include "sscope/workloads/utils.h"

#include <chrono>
#include <cstdint>
#include <thread>
#include <vector>

namespace sscope {

// Each thread runs its own LCG — no shared state, measures thread spawn overhead.
static void run_thread_lcg(uint64_t n) {
    uint64_t result = 0x123456789ABCDEF0ULL;
    for (uint64_t i = 0; i < n; ++i) {
        result = result * 6364136223846793005ULL + 1442695040888963407ULL;
        DoNotOptimize(result);
    }
    ClobberMemory();
}

WorkloadResult run_thread_scaling() {
    unsigned int nthreads = std::thread::hardware_concurrency();
    if (nthreads == 0) nthreads = 1;

    uint64_t n_inner = calibrate([](uint64_t n) { run_thread_lcg(n); });

    auto run_parallel = [&](uint64_t n) {
        std::vector<std::thread> workers;
        workers.reserve(nthreads);
        for (unsigned int t = 0; t < nthreads; ++t)
            workers.emplace_back([n] { run_thread_lcg(n); });
        for (auto& w : workers) w.join();
    };

    for (int i = 0; i < WARMUP_ITERATIONS; ++i)
        run_parallel(n_inner);

    std::vector<MeasurementRow> rows;
    rows.reserve(MEASUREMENT_ITERATIONS);
    for (int i = 0; i < MEASUREMENT_ITERATIONS; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        run_parallel(n_inner);
        auto t1 = std::chrono::high_resolution_clock::now();
        double elapsed_ns = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
        double per_iter_ns = elapsed_ns / static_cast<double>(n_inner);
        rows.push_back({per_iter_ns, per_iter_ns, n_inner, 0.0,
                        static_cast<double>(nthreads)});
    }

    std::vector<double> samples;
    samples.reserve(rows.size());
    for (auto& r : rows) samples.push_back(r.real_time_ns);

    WorkloadResult res;
    res.benchmark_name = "BM_thread_scaling";
    res.raw_rows       = std::move(rows);
    res.stats          = compute_stats(std::move(samples));
    return res;
}

} // namespace sscope

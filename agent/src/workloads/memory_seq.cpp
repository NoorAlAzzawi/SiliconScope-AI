#include "sscope/workloads/utils.h"

#include <chrono>
#include <cstdint>
#include <cstring>
#include <vector>

namespace sscope {

static constexpr size_t SEQ_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB

static void run_memcpy_seq(uint64_t n) {
    static std::vector<uint8_t> src(SEQ_BUFFER_BYTES, 0xAB);
    static std::vector<uint8_t> dst(SEQ_BUFFER_BYTES, 0);
    for (uint64_t i = 0; i < n; ++i) {
        std::memcpy(dst.data(), src.data(), SEQ_BUFFER_BYTES);
        DoNotOptimize(dst[0]);
    }
    ClobberMemory();
}

WorkloadResult run_memory_seq() {
    uint64_t n_inner = calibrate([](uint64_t n) { run_memcpy_seq(n); });

    for (int i = 0; i < WARMUP_ITERATIONS; ++i)
        run_memcpy_seq(n_inner);

    std::vector<MeasurementRow> rows;
    rows.reserve(MEASUREMENT_ITERATIONS);
    for (int i = 0; i < MEASUREMENT_ITERATIONS; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        run_memcpy_seq(n_inner);
        auto t1 = std::chrono::high_resolution_clock::now();
        double elapsed_ns = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
        double per_iter_ns = elapsed_ns / static_cast<double>(n_inner);
        double bps = (static_cast<double>(SEQ_BUFFER_BYTES) / (elapsed_ns * 1e-9))
                     * static_cast<double>(n_inner);
        rows.push_back({per_iter_ns, per_iter_ns, n_inner, bps, 0.0});
    }

    std::vector<double> samples;
    samples.reserve(rows.size());
    for (auto& r : rows) samples.push_back(r.real_time_ns);

    WorkloadResult res;
    res.benchmark_name = "BM_memory_seq_memcpy";
    res.raw_rows       = std::move(rows);
    res.stats          = compute_stats(std::move(samples));
    return res;
}

} // namespace sscope

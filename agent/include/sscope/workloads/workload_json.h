#pragma once

#include "sscope/workloads/utils.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <vector>

namespace sscope {

// Associates a workload name with its measurement results.
struct NamedWorkloadResult {
    const char*    name;
    WorkloadResult result;
};

// Serialize a collection of workload results as a Google Benchmark JSON document
// suitable for BenchmarkImporter::import().
//
// Each WorkloadResult contributes one row per raw sample, all under the same
// benchmark name, with run_type="iteration".  This yields data_type=
// "raw_samples_available" for each benchmark case in the imported session.
//
// bytes_per_second and items_per_second are included only when non-zero to
// avoid polluting CPU workload entries with spurious zeros.
//
// build_type must not be null; pass the SSCOPE_BUILD_TYPE compile-time constant
// or a literal such as "Release" / "Debug".
inline nlohmann::json build_run_json(
        const std::vector<NamedWorkloadResult>& entries,
        const char* build_type) {
    nlohmann::json doc  = nlohmann::json::object();
    nlohmann::json ctx  = nlohmann::json::object();
    ctx["executable"]   = "sscope";
    ctx["build_type"]   = (build_type && build_type[0] != '\0') ? build_type : "unknown";
    doc["context"]      = ctx;

    nlohmann::json benchmarks = nlohmann::json::array();
    for (const auto& e : entries) {
        for (const auto& row : e.result.raw_rows) {
            nlohmann::json brow  = nlohmann::json::object();
            brow["name"]         = e.name;
            brow["run_type"]     = "iteration";
            brow["real_time"]    = row.real_time_ns;
            brow["cpu_time"]     = row.cpu_time_ns;
            brow["time_unit"]    = "ns";
            brow["iterations"]   = static_cast<int64_t>(row.iterations);
            if (row.bytes_per_second > 0.0)
                brow["bytes_per_second"] = row.bytes_per_second;
            if (row.items_per_second > 0.0)
                brow["items_per_second"] = row.items_per_second;
            benchmarks.push_back(std::move(brow));
        }
    }
    doc["benchmarks"] = benchmarks;
    return doc;
}

} // namespace sscope

#pragma once
// Sort comparator used to build the canonical cases array in the fingerprint
// object F (API_CONTRACTS.md §5.3).
//
// Sort key: project_name + NUL + canonical_name
//
// Extracted here so regression tests can import and exercise the same
// comparator that benchmark_importer.cpp uses.

#include <nlohmann/json.hpp>
#include <string>

namespace sscope {
namespace detail {

inline bool benchmark_case_less(const nlohmann::json& a, const nlohmann::json& b) {
    std::string ka = a["project_name"].get<std::string>()
                     + '\0' + a["canonical_name"].get<std::string>();
    std::string kb = b["project_name"].get<std::string>()
                     + '\0' + b["canonical_name"].get<std::string>();
    return ka < kb;
}

} // namespace detail
} // namespace sscope

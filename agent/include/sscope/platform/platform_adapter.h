#pragma once
#include <cstdint>
#include <memory>
#include <string>

namespace sscope {

// Hardware and OS information collected once at startup.
// All fields are populated by make_platform_adapter().
// Fields that are genuinely unavailable carry "unavailable" (string) or 0 (numeric).
// "unavailable" is a reserved sentinel per API_CONTRACTS.md §4.3; comparisons
// with either run having isa or os_name == "unavailable" return HTTP 422
// COMPARISON_INELIGIBLE (CX-BS-1).
struct PlatformInfo {
    std::string cpu_name;       // FR-A-001; "unavailable" if not detectable
    std::string isa;            // "arm64" | "x86_64" | "unavailable"
    std::string os_name;        // e.g. "macOS"; "unavailable" if not detectable
    std::string os_version;     // FR-A-005; e.g. "14.6.1"; "unavailable" if not detectable

    uint32_t physical_cores = 0;
    uint32_t logical_cores  = 0;
    uint64_t base_freq_mhz  = 0;   // 0 when unavailable (common on Apple Silicon)
    uint64_t total_mem_bytes = 0;
};

// Abstract interface for platform-specific information gathering.
// The macOS implementation uses sysctl / IOKit.
// Adding a new platform adds one .cpp; no changes to this header.
class PlatformAdapter {
public:
    virtual ~PlatformAdapter() = default;
    virtual PlatformInfo gather() const = 0;
};

// Factory — returns the platform-appropriate implementation.
// On macOS, returns MacosPlatformAdapter.
std::unique_ptr<PlatformAdapter> make_platform_adapter();

} // namespace sscope

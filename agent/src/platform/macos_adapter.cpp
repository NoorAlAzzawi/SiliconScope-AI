#include "sscope/platform/platform_adapter.h"

#include <sys/sysctl.h>
#include <sys/utsname.h>

#include <string>
#include <thread>

namespace sscope {

namespace {

// Call sysctlbyname and return the string value, or "" on failure.
static std::string sysctl_str(const char* name) {
    size_t len = 0;
    if (sysctlbyname(name, nullptr, &len, nullptr, 0) != 0 || len == 0)
        return "";
    std::string result(len, '\0');
    if (sysctlbyname(name, result.data(), &len, nullptr, 0) != 0)
        return "";
    // trim trailing NUL that sysctl appends
    while (!result.empty() && result.back() == '\0')
        result.pop_back();
    return result;
}

static uint64_t sysctl_u64(const char* name) {
    uint64_t val = 0;
    size_t len = sizeof(val);
    sysctlbyname(name, &val, &len, nullptr, 0);
    return val;
}

static uint32_t sysctl_u32(const char* name) {
    uint32_t val = 0;
    size_t len = sizeof(val);
    sysctlbyname(name, &val, &len, nullptr, 0);
    return val;
}

class MacosPlatformAdapter final : public PlatformAdapter {
public:
    PlatformInfo gather() const override {
        PlatformInfo info;

        // CPU name: machdep.cpu.brand_string works on Intel; hw.model is the
        // best available on Apple Silicon (e.g. "Apple M2 Pro").
        info.cpu_name = sysctl_str("machdep.cpu.brand_string");
        if (info.cpu_name.empty())
            info.cpu_name = sysctl_str("hw.model");
        if (info.cpu_name.empty())
            info.cpu_name = "unavailable";

        // ISA from uname().machine: "arm64" or "x86_64".
        struct utsname u{};
        if (uname(&u) == 0 && u.machine[0] != '\0')
            info.isa = u.machine;
        else
            info.isa = "unavailable";

        // OS name is always "macOS" on this platform.
        info.os_name = "macOS";

        // OS version: kern.osproductversion → "14.6.1"
        info.os_version = sysctl_str("kern.osproductversion");
        if (info.os_version.empty())
            info.os_version = "unavailable";

        // Core counts.
        info.physical_cores = sysctl_u32("hw.physicalcpu");
        info.logical_cores  = sysctl_u32("hw.logicalcpu");
        if (info.logical_cores == 0)
            info.logical_cores = static_cast<uint32_t>(
                std::thread::hardware_concurrency());

        // Base frequency: hw.cpufrequency in Hz → MHz.
        // Commonly unavailable (returns 0) on Apple Silicon; that is fine.
        uint64_t hz = sysctl_u64("hw.cpufrequency");
        info.base_freq_mhz = (hz > 0) ? (hz / 1'000'000ULL) : 0;

        // Total memory.
        info.total_mem_bytes = sysctl_u64("hw.memsize");

        return info;
    }
};

} // anonymous namespace

std::unique_ptr<PlatformAdapter> make_platform_adapter() {
    return std::make_unique<MacosPlatformAdapter>();
}

} // namespace sscope

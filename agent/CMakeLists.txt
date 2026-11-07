cmake_minimum_required(VERSION 3.21)
project(sscope VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Third-party: SQLite amalgamation ────────────────────────────────────────
add_library(sqlite3 STATIC
    third_party/sqlite3/sqlite3.c
)
target_include_directories(sqlite3 PUBLIC third_party/sqlite3)
set_source_files_properties(third_party/sqlite3/sqlite3.c
    PROPERTIES COMPILE_FLAGS "-w")   # suppress upstream warnings

# ── Third-party: Ryu (ES2019 Number::toString, v2.0, ulfjack/ryu) ───────────
# Only d2s.c is needed: double→string.  f2s (float) and s2d (parse) are not
# used.  Files live under third_party/ryu/ryu/ to match the upstream include
# paths ("ryu/ryu.h", "ryu/common.h", etc.).
add_library(ryu STATIC
    third_party/ryu/ryu/d2s.c
)
target_include_directories(ryu PUBLIC third_party/ryu)
set_source_files_properties(
    third_party/ryu/ryu/d2s.c
    PROPERTIES COMPILE_FLAGS "-w")

# ── Core library: sscope_core ────────────────────────────────────────────────
# All sources except main.cpp; linked by both the executable and the test suite.
add_library(sscope_core STATIC
    src/db/local_db.cpp
    src/platform/macos_adapter.cpp
    src/fingerprint/fingerprint.cpp
    src/import/benchmark_importer.cpp
    src/registration/registration.cpp
    src/workloads/cpu_integer.cpp
    src/workloads/cpu_float.cpp
    src/workloads/memory_seq.cpp
    src/workloads/memory_rand.cpp
    src/workloads/thread_scaling.cpp
    src/sync/sync_client.cpp
    src/sync/pending_flush.cpp
)

target_include_directories(sscope_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/nlohmann_json
)

target_link_libraries(sscope_core PUBLIC
    sqlite3
    ryu
    "-framework CoreFoundation"
    "-framework IOKit"
    "-framework Security"
)

find_package(CURL REQUIRED)
target_link_libraries(sscope_core PUBLIC CURL::libcurl)

# ── Main executable: sscope ─────────────────────────────────────────────────
add_executable(sscope src/main.cpp)
target_link_libraries(sscope PRIVATE sscope_core)
# Inject the actual build configuration as a string constant.
# $<CONFIG> expands to "Release", "Debug", etc.; falls back to "unknown"
# when no CMAKE_BUILD_TYPE is set (common with bare Makefile generators).
target_compile_definitions(sscope PRIVATE
    "SSCOPE_BUILD_TYPE=\"$<IF:$<BOOL:$<CONFIG>>,$<CONFIG>,unknown>\"")

# ── Tests ────────────────────────────────────────────────────────────────────
enable_testing()
add_subdirectory(tests)

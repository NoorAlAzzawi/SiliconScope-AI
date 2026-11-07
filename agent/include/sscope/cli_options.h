#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace sscope {

struct Options {
    std::string command;
    std::string import_file;
    std::string db_path;
    std::string server_url;
    std::string api_key;
    std::string backend_url;
    std::optional<std::string> commit_sha;
    std::optional<std::string> build_config_flag;
    std::vector<std::string>   positional_args;
    std::string source_filter;
    int         limit         = 0;
    std::string output_format;
};

// Injectable version of apply_stored_credentials for unit testing.
// The API key loader is only called when a server URL is configured —
// either passed explicitly or resolved by load_server_url_fn.
inline Options apply_stored_credentials_impl(
    Options opts,
    std::function<std::string()> load_server_url_fn,
    std::function<std::string()> load_api_key_fn
) {
    if (opts.server_url.empty())
        opts.server_url = load_server_url_fn();
    if (opts.api_key.empty() && !opts.server_url.empty())
        opts.api_key = load_api_key_fn();
    return opts;
}

} // namespace sscope

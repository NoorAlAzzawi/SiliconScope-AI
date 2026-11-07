#pragma once
#include <optional>
#include <string>

namespace sscope {

int cmd_register(const std::string& backend_url);

// Load the stored backend URL from ~/.config/sscope/config.json.
// Returns an empty string if not registered or the file is missing/malformed.
std::string load_server_url();

// Load the stored API key from the macOS Keychain.
// Returns an empty string if the device is not registered (silent).
// Prints a diagnostic to stderr and returns "" on:
//   errSecInteractionNotAllowed — macOS authorization required (not an invalid key).
//   Other Keychain errors       — reports the OSStatus code.
std::string load_api_key();

// Returns the stored device ID without creating a new one.
// Returns nullopt if the device has not been registered.
std::optional<std::string> try_load_device_id();

} // namespace sscope

#include "sscope/registration/registration.h"

#include <nlohmann/json.hpp>
#include <curl/curl.h>
#include <Security/Security.h>

#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>

#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>

namespace sscope {

namespace fs = std::filesystem;
using json = nlohmann::json;

static std::string gen_uuid_v4() {
    std::random_device rd;
    std::mt19937_64 gen(rd());
    std::uniform_int_distribution<uint64_t> dist;
    uint64_t hi = dist(gen);
    uint64_t lo = dist(gen);
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;
    std::ostringstream oss;
    oss << std::hex << std::setfill('0')
        << std::setw(8) << (hi >> 32)
        << '-' << std::setw(4) << ((hi >> 16) & 0xFFFF)
        << '-' << std::setw(4) << (hi & 0xFFFF)
        << '-' << std::setw(4) << (lo >> 48)
        << '-' << std::setw(12) << (lo & 0x0000FFFFFFFFFFFFULL);
    return oss.str();
}

static fs::path config_dir() {
    const char* home = std::getenv("HOME");
    if (!home)
        throw std::runtime_error("HOME environment variable not set");
    return fs::path(home) / ".config" / "sscope";
}

static void ensure_config_dir(const fs::path& dir) {
    if (!fs::exists(dir)) {
        fs::create_directories(dir);
        chmod(dir.c_str(), 0700);
    }
}

static std::string load_or_create_device_id(const fs::path& dir) {
    fs::path id_path = dir / "device_id";
    if (fs::exists(id_path)) {
        std::ifstream f(id_path);
        std::string id;
        std::getline(f, id);
        return id;
    }
    std::string id = gen_uuid_v4();
    {
        std::ofstream f(id_path);
        f << id;
    }
    chmod(id_path.c_str(), 0600);
    return id;
}

static std::string read_hidden_token() {
    std::cerr << "Registration token: " << std::flush;

    struct termios old_term{}, new_term{};
    tcgetattr(STDIN_FILENO, &old_term);
    new_term = old_term;
    new_term.c_lflag &= ~static_cast<tcflag_t>(ECHO);
    tcsetattr(STDIN_FILENO, TCSANOW, &new_term);

    std::string token;
    std::getline(std::cin, token);

    tcsetattr(STDIN_FILENO, TCSANOW, &old_term);
    std::cerr << '\n';

    return token;
}

static size_t curl_write_cb(char* ptr, size_t size, size_t nmemb, std::string* out) {
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

struct HttpResponse {
    long code;
    std::string body;
};

static HttpResponse http_post_json(const std::string& url, const std::string& body) {
    CURL* curl = curl_easy_init();
    if (!curl)
        throw std::runtime_error("curl_easy_init failed");

    HttpResponse resp{0, {}};
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        std::string err = curl_easy_strerror(res);
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        throw std::runtime_error(err);
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return resp;
}

static constexpr const char* kKeychainService = "sscope-api-key";

static void store_api_key_in_keychain(const std::string& device_id, const std::string& api_key) {
    SecKeychainItemRef existing = nullptr;
    OSStatus find_status = SecKeychainFindGenericPassword(
        nullptr,
        static_cast<UInt32>(strlen(kKeychainService)), kKeychainService,
        static_cast<UInt32>(device_id.size()), device_id.c_str(),
        nullptr, nullptr,
        &existing
    );
    if (find_status == errSecSuccess && existing) {
        SecKeychainItemDelete(existing);
        CFRelease(existing);
    }

    OSStatus add_status = SecKeychainAddGenericPassword(
        nullptr,
        static_cast<UInt32>(strlen(kKeychainService)), kKeychainService,
        static_cast<UInt32>(device_id.size()), device_id.c_str(),
        static_cast<UInt32>(api_key.size()), api_key.c_str(),
        nullptr
    );
    if (add_status != errSecSuccess) {
        throw std::runtime_error("SecKeychainAddGenericPassword failed: " +
                                 std::to_string(add_status));
    }
}

static void write_config(const fs::path& dir, const std::string& backend_url) {
    fs::path cfg_path = dir / "config.json";
    json cfg;
    cfg["backend_url"] = backend_url;
    {
        std::ofstream f(cfg_path);
        f << cfg.dump(2) << '\n';
    }
    chmod(cfg_path.c_str(), 0600);
}

std::string load_server_url() {
    const char* home = std::getenv("HOME");
    if (!home) return "";
    fs::path cfg_path = fs::path(home) / ".config" / "sscope" / "config.json";
    if (!fs::exists(cfg_path)) return "";
    try {
        std::ifstream f(cfg_path);
        json cfg = json::parse(f);
        if (cfg.contains("backend_url") && cfg["backend_url"].is_string())
            return cfg["backend_url"].get<std::string>();
    } catch (...) {}
    return "";
}

std::string load_api_key() {
    const char* home = std::getenv("HOME");
    if (!home) return "";
    fs::path id_path = fs::path(home) / ".config" / "sscope" / "device_id";
    if (!fs::exists(id_path)) return "";
    std::string device_id;
    try {
        std::ifstream f(id_path);
        std::getline(f, device_id);
    } catch (...) { return ""; }
    if (device_id.empty()) return "";

    // Use SecItemCopyMatching (modern API) with kSecUseNoAuthenticationUI so
    // that the call never blocks waiting for a user dialog in non-interactive
    // contexts (CI, terminal agents, automated tests).
    CFStringRef service_cf = CFStringCreateWithCString(
        nullptr, kKeychainService, kCFStringEncodingUTF8);
    CFStringRef account_cf = CFStringCreateWithCString(
        nullptr, device_id.c_str(), kCFStringEncodingUTF8);

    const void* keys[] = {
        kSecClass, kSecAttrService, kSecAttrAccount,
        kSecReturnData, kSecUseNoAuthenticationUI
    };
    const void* values[] = {
        kSecClassGenericPassword, service_cf, account_cf,
        kCFBooleanTrue, kCFBooleanTrue
    };
    CFDictionaryRef q = CFDictionaryCreate(
        nullptr, keys, values, 5,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    CFRelease(service_cf);
    CFRelease(account_cf);

    CFTypeRef result_ref = nullptr;
    OSStatus status = SecItemCopyMatching(q, &result_ref);
    CFRelease(q);

    if (status == errSecItemNotFound) return ""; // Not registered; caller handles empty key.

    if (status == errSecInteractionNotAllowed) {
        // kSecUseNoAuthenticationUI means this call never shows a dialog.
        // errSecInteractionNotAllowed means the item exists but the current binary
        // is not in its ACL — typically because the binary was rebuilt.
        // The user must resolve this in Keychain Access.app or by re-registering.
        std::cerr << "[sscope] Keychain access to '" << kKeychainService << "' was blocked"
                     " by macOS (errSecInteractionNotAllowed).\n"
                     "         This is a macOS authorization issue — the API key itself"
                     " is not invalid.\n"
                     "         No dialog will appear; to restore access choose one option:\n"
                     "           A) Open Keychain Access.app, find '" << kKeychainService
                  << "',\n"
                     "              open its Access Control tab, and add this binary to the"
                     " allowed list.\n"
                     "           B) Re-run 'sscope register' to create a new Keychain entry"
                     " for this binary.\n";
        return "";
    }

    if (status != errSecSuccess || !result_ref) {
        std::cerr << "[sscope] Failed to read API key from Keychain (macOS error: "
                  << status << ").\n";
        return "";
    }

    CFDataRef data = static_cast<CFDataRef>(result_ref);
    std::string api_key(
        reinterpret_cast<const char*>(CFDataGetBytePtr(data)),
        static_cast<size_t>(CFDataGetLength(data)));
    CFRelease(result_ref);
    return api_key;
}

std::optional<std::string> try_load_device_id() {
    const char* home = std::getenv("HOME");
    if (!home) return std::nullopt;
    fs::path id_path = fs::path(home) / ".config" / "sscope" / "device_id";
    if (!fs::exists(id_path)) return std::nullopt;
    try {
        std::ifstream f(id_path);
        std::string id;
        std::getline(f, id);
        return id.empty() ? std::nullopt : std::optional<std::string>{id};
    } catch (...) { return std::nullopt; }
}

int cmd_register(const std::string& backend_url) {
    fs::path cfg_dir = config_dir();

    try {
        ensure_config_dir(cfg_dir);
    } catch (const std::exception& e) {
        std::cerr << "error: could not create config directory: " << e.what() << '\n';
        return 1;
    }

    std::string device_id;
    try {
        device_id = load_or_create_device_id(cfg_dir);
    } catch (const std::exception& e) {
        std::cerr << "error: could not load device ID: " << e.what() << '\n';
        return 1;
    }

    char hostname_buf[256] = {};
    if (gethostname(hostname_buf, sizeof(hostname_buf)) != 0) {
        std::cerr << "error: gethostname failed\n";
        return 1;
    }
    std::string device_name = hostname_buf;

    std::string token = read_hidden_token();

    json payload;
    payload["device_id"]   = device_id;
    payload["device_name"] = device_name;
    payload["setup_token"] = token;

    std::string endpoint = backend_url + "/api/v1/register";
    HttpResponse resp;
    try {
        resp = http_post_json(endpoint, payload.dump());
    } catch (const std::exception& e) {
        std::cerr << "error: could not connect to backend at " << backend_url
                  << ": " << e.what() << '\n';
        return 3;
    }

    if (resp.code == 201) {
        try {
            json body = json::parse(resp.body);
            std::string api_key = body.at("api_key").get<std::string>();
            store_api_key_in_keychain(device_id, api_key);
            write_config(cfg_dir, backend_url);
        } catch (const std::exception& e) {
            std::cerr << "error: failed to process registration response: " << e.what() << '\n';
            return 1;
        }
        std::cout << "Registration successful. Device ID: " << device_id << '\n';
        return 0;
    } else if (resp.code == 401) {
        std::cerr << "error: setup token is invalid or has already been used.\n";
        return 1;
    } else if (resp.code == 409) {
        std::cerr << "error: the setup token was consumed but the server could not complete registration. Restart the backend to generate a new token.\n";
        return 1;
    } else {
        std::cerr << "error: registration failed (HTTP " << resp.code << "): "
                  << resp.body << '\n';
        return 1;
    }
}

} // namespace sscope

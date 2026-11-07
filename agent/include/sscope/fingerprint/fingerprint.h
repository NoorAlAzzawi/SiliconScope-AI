#pragma once
#include <string>
#include <string_view>

// nlohmann/json v3.11.3 uses an inline ABI namespace (json_abi_v3_11_3).
// A bare forward declaration conflicts with it; include the full header here.
#include <nlohmann/json.hpp>

// RFC 8785 JSON Canonicalization Scheme (JCS) serializer + SHA-256 fingerprint.
//
// Implementation contract (B-1, API_CONTRACTS.md §5.4):
//   - Number serialization: ES2019 Number::toString via Ryu (not std::to_chars alone).
//   - Object key ordering: UTF-16 code unit order (not Unicode code point order).
//     Supplementary-plane keys (U+10000+) sort by high surrogate value, which places
//     them before BMP characters above U+D7FF.  Verified by CT-RFC8785-04.
//   - nlohmann::json::dump() is NOT used for serialization output.

namespace sscope {

// Serialize a nlohmann::json value to a UTF-8 string conforming to RFC 8785.
// Returns the canonical byte sequence; no trailing newline.
// Precondition: the value contains no NaN or ±Infinity (must be rejected upstream).
std::string jcs_serialize(const nlohmann::json& value);

// Compute SHA-256(jcs_serialize(value)) and return 64 lowercase hex characters.
std::string jcs_sha256_hex(const nlohmann::json& value);

// Low-level helpers exposed for unit testing.
namespace detail {
    // ES2019 Number::toString for one finite IEEE 754 double.
    // Returns "0" for -0.0; integer-valued doubles return no decimal point.
    std::string serialize_number(double v);

    // Compare two UTF-8 strings by UTF-16 code unit order (RFC 8785 §3.2.3).
    bool utf16_less(std::string_view a, std::string_view b);
}

} // namespace sscope

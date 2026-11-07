#include "sscope/fingerprint/fingerprint.h"
// nlohmann/json.hpp is already included transitively via fingerprint.h

// Ryu: ES2019-compliant Number::toString for IEEE 754 doubles.
// d2s_buffered_n writes the shortest decimal that round-trips,
// in fixed notation for |v| < 10^21 (ES2019 §7.1.12.1).
// Include path: third_party/ryu → resolves "ryu/ryu.h" correctly.
extern "C" {
#include "ryu/ryu.h"
}

// Apple CommonCrypto for SHA-256 (available on all macOS versions).
#include <CommonCrypto/CommonDigest.h>

#include <cassert>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

using nlohmann::json;

namespace sscope {

// ── UTF-8 decoding helpers ───────────────────────────────────────────────────

namespace {

// Decode one UTF-8 sequence starting at src[0..len).
// Returns the Unicode code point and advances *pos past the sequence.
// Returns U+FFFD and advances by 1 on invalid input.
uint32_t utf8_decode(const char* src, size_t len, size_t* pos) {
    unsigned char c = static_cast<unsigned char>(src[*pos]);
    uint32_t cp;
    size_t extra;

    if (c < 0x80) {
        cp = c; extra = 0;
    } else if (c < 0xC0) {
        // Continuation byte at start — malformed.
        cp = 0xFFFD; extra = 0;
    } else if (c < 0xE0) {
        cp = c & 0x1F; extra = 1;
    } else if (c < 0xF0) {
        cp = c & 0x0F; extra = 2;
    } else if (c < 0xF8) {
        cp = c & 0x07; extra = 3;
    } else {
        cp = 0xFFFD; extra = 0;
    }

    size_t p = *pos + 1;
    for (size_t i = 0; i < extra && p < len; ++i, ++p) {
        unsigned char b = static_cast<unsigned char>(src[p]);
        if ((b & 0xC0) != 0x80) { cp = 0xFFFD; break; }
        cp = (cp << 6) | (b & 0x3F);
    }

    *pos = p;
    return cp;
}

// Convert a code point to its UTF-16 representation (one or two code units).
// Supplementary-plane characters (U+10000..U+10FFFF) produce a surrogate pair.
// BMP characters produce a single code unit.
// Returns the number of code units written (1 or 2).
int cp_to_utf16(uint32_t cp, uint16_t out[2]) {
    if (cp < 0x10000) {
        out[0] = static_cast<uint16_t>(cp);
        return 1;
    }
    uint32_t prime = cp - 0x10000;
    out[0] = static_cast<uint16_t>(0xD800 + (prime >> 10));   // high surrogate
    out[1] = static_cast<uint16_t>(0xDC00 + (prime & 0x3FF)); // low surrogate
    return 2;
}

} // anonymous namespace

// ── detail::utf16_less ───────────────────────────────────────────────────────
// RFC 8785 §3.2.3: object keys are sorted by their UTF-16 code unit sequences,
// compared lexicographically.  This is NOT the same as Unicode code-point order
// when supplementary-plane characters are involved: U+10000 encodes as the
// surrogate pair (0xD800, 0xDC00), and 0xD800 < any BMP value > U+D7FF.
// CT-RFC8785-04 specifically tests this case.

bool detail::utf16_less(std::string_view a, std::string_view b) {
    size_t ia = 0, ib = 0;

    while (ia < a.size() && ib < b.size()) {
        uint32_t cpa = utf8_decode(a.data(), a.size(), &ia);
        uint32_t cpb = utf8_decode(b.data(), b.size(), &ib);

        uint16_t ua[2], ub[2];
        int na = cp_to_utf16(cpa, ua);
        int nb = cp_to_utf16(cpb, ub);

        for (int i = 0; i < std::min(na, nb); ++i) {
            if (ua[i] != ub[i]) return ua[i] < ub[i];
        }
        if (na != nb) return na < nb;
    }

    return ia >= a.size() && ib < b.size(); // a exhausted first → a < b
}

// ── detail::serialize_number ─────────────────────────────────────────────────
// ES2019 Number::toString (§7.1.12.1).
//
// Key properties:
//   1. -0.0  → "0"
//   2. v == floor(v) and |v| < 2^53  → integer notation via to_chars(long long)
//   3. All others → Ryu d2s_buffered_n, which implements ES2019 shortest-round-trip
//      in fixed notation for |v| < 10^21 and exponential for |v| >= 10^21.
//
// std::to_chars with chars_format::general is NOT used because it selects
// scientific notation by comparing string lengths, not by the ES2019 threshold of
// 10^21.  For example, 1e15 → "1e+15" from to_chars but "1000000000000000" from
// ES2019.  Ryu implements the correct semantics.

// Apply ES2019 §7.1.12.1 formatting to Ryu's output.
//
// Ryu v2.0 produces its own scientific-notation format:  1.5E0, 1E-1, 4.2949672965E9
// ES2019 Number::toString requires fixed notation where possible:  1.5, 0.1, 4294967296.5
//
// Both compute the SAME shortest round-trip decimal digits; only the presentation differs.
// This function parses Ryu's output to extract (digits, n) and reformats per ES2019.
//
// n is ES2019's "n" (the decimal-point position):
//   n = ryu_exponent + 1    e.g. "1.5E0" → exp=0, n=1; "1E-1" → exp=-1, n=0
//
// ES2019 formatting rules (k = number of significant digits, s = digit string):
//   k <= n <= 21             → integer:  s + (n-k) trailing zeros
//   0 < n <= 21              → decimal:  s[0..n] + '.' + s[n..]
//   -6 < n <= 0              → small:    "0." + (-n) zeros + s
//   k==1, n<=-6 or n>21      → sci:      s + "e+" or "e-" + |n-1|
//   otherwise, n<=-6 or n>21 → sci:      s[0] + '.' + s[1..] + "e+" or "e-" + |n-1|

static std::string ryu_to_es2019(const char* ryu_buf, int ryu_len) {
    // Parse: [-] [digits] [. [digits]] E [+-] [exp digits]
    int i = 0;
    bool negative = false;
    if (ryu_buf[0] == '-') { negative = true; i = 1; }

    std::string s;  // significant digit string
    for (; i < ryu_len && ryu_buf[i] != 'E'; i++) {
        if (ryu_buf[i] != '.') s += ryu_buf[i];
    }
    ++i;  // skip 'E'

    int esign = 1;
    if (i < ryu_len && ryu_buf[i] == '+') ++i;
    else if (i < ryu_len && ryu_buf[i] == '-') { esign = -1; ++i; }

    int ryu_exp = 0;
    for (; i < ryu_len; i++) ryu_exp = ryu_exp * 10 + (ryu_buf[i] - '0');
    ryu_exp *= esign;

    int k = static_cast<int>(s.size());
    int n = ryu_exp + 1;   // ES2019's n

    std::string out;
    if (negative) out += '-';

    if (k <= n && n <= 21) {
        // Integer: append trailing zeros.
        out += s;
        out.append(static_cast<size_t>(n - k), '0');
    } else if (0 < n && n <= 21) {
        // Fixed decimal.
        out += s.substr(0, static_cast<size_t>(n));
        out += '.';
        out += s.substr(static_cast<size_t>(n));
    } else if (-6 < n && n <= 0) {
        // Small: "0." + leading zeros + digits.
        out += "0.";
        out.append(static_cast<size_t>(-n), '0');
        out += s;
    } else {
        // Scientific notation (ES2019 uses lowercase 'e').
        if (k == 1) {
            out += s;
        } else {
            out += s[0];
            out += '.';
            out += s.substr(1);
        }
        out += 'e';
        int exp_disp = n - 1;
        if (exp_disp >= 0) out += '+';
        char ebuf[16];
        auto [end, ec] = std::to_chars(ebuf, ebuf + sizeof(ebuf), exp_disp);
        out += std::string(ebuf, end);
    }

    return out;
}

std::string detail::serialize_number(double v) {
    // RFC 8785 §3.2.2.3: NaN and Infinity are not valid JSON numbers.
    // Throw rather than silently emitting "null" — a wrong fingerprint is
    // worse than a hard failure; the import pipeline must reject these first.
    if (std::isnan(v)) {
        throw std::invalid_argument(
            "jcs_serialize: NaN is not a valid JSON number (RFC 8785 §3.2.2.3)");
    }
    if (std::isinf(v)) {
        throw std::invalid_argument(
            "jcs_serialize: Infinity is not a valid JSON number (RFC 8785 §3.2.2.3)");
    }

    // Negative zero → "0" (ES2019: Number(-0).toString() == "0").
    if (std::signbit(v) && v == 0.0) return "0";

    // Integer-valued double in (-(2^53), 2^53): use integer formatting directly.
    double abs_v = std::fabs(v);
    if (abs_v < 9007199254740992.0 && v == std::floor(v)) {
        char buf[32];
        long long iv = static_cast<long long>(v);
        auto [end, ec] = std::to_chars(buf, buf + sizeof(buf), iv);
        return std::string(buf, end);
    }

    // General case: use Ryu for the shortest round-trip digit string,
    // then reformat to ES2019 Number::toString presentation.
    char ryu_buf[32];  // Ryu guarantees output fits in 25 bytes.
    int n = d2s_buffered_n(v, ryu_buf);
    return ryu_to_es2019(ryu_buf, n);
}

// ── RFC 8259 string escaping ─────────────────────────────────────────────────
// RFC 8785 §3.2.2.2 requires RFC 8259 minimal escaping:
//   U+0000..U+001F → \uXXXX
//   U+0022 (") → \"
//   U+005C (\) → \\
// All other characters pass through as UTF-8.

namespace {
void append_json_string(std::string& out, std::string_view sv) {
    out += '"';
    for (size_t i = 0; i < sv.size(); ) {
        unsigned char c = static_cast<unsigned char>(sv[i]);
        if (c == '"') {
            out += "\\\""; ++i;
        } else if (c == '\\') {
            out += "\\\\"; ++i;
        } else if (c < 0x20) {
            // Control character: \uXXXX.
            char esc[7];
            std::snprintf(esc, sizeof(esc), "\\u%04x", c);
            out += esc; ++i;
        } else {
            // Pass UTF-8 sequence through unchanged.
            out += static_cast<char>(c); ++i;
        }
    }
    out += '"';
}
} // anonymous namespace

// ── jcs_serialize ────────────────────────────────────────────────────────────
// Recursively serializes a nlohmann::json value to RFC 8785 canonical form.
// nlohmann::json::dump() is NOT called; it does not implement UTF-16 key order
// or ES2019 number serialization.

std::string jcs_serialize(const json& value) {
    std::string out;
    out.reserve(256);

    switch (value.type()) {
        case json::value_t::null:
            out += "null";
            break;

        case json::value_t::boolean:
            out += value.get<bool>() ? "true" : "false";
            break;

        case json::value_t::number_integer:
        case json::value_t::number_unsigned: {
            // Integer types: serialize directly without Ryu.
            char buf[32];
            if (value.type() == json::value_t::number_integer) {
                auto [end, ec] = std::to_chars(
                    buf, buf + sizeof(buf), value.get<long long>());
                out += std::string(buf, end);
            } else {
                auto [end, ec] = std::to_chars(
                    buf, buf + sizeof(buf), value.get<unsigned long long>());
                out += std::string(buf, end);
            }
            break;
        }

        case json::value_t::number_float: {
            // serialize_number throws std::invalid_argument for NaN/Infinity.
            out += detail::serialize_number(value.get<double>());
            break;
        }

        case json::value_t::string: {
            append_json_string(out, value.get<std::string_view>());
            break;
        }

        case json::value_t::array: {
            out += '[';
            bool first = true;
            for (const auto& elem : value) {
                if (!first) out += ',';
                out += jcs_serialize(elem);
                first = false;
            }
            out += ']';
            break;
        }

        case json::value_t::object: {
            // Collect keys and sort by UTF-16 code unit order (RFC 8785 §3.2.3).
            std::vector<std::string_view> keys;
            keys.reserve(value.size());
            for (auto it = value.begin(); it != value.end(); ++it) {
                keys.push_back(it.key());
            }
            std::sort(keys.begin(), keys.end(), detail::utf16_less);

            out += '{';
            bool first = true;
            for (const auto& k : keys) {
                if (!first) out += ',';
                append_json_string(out, k);
                out += ':';
                out += jcs_serialize(value.at(std::string(k)));
                first = false;
            }
            out += '}';
            break;
        }

        default:
            // json::value_t::discarded and any future unknown types.
            // Throw rather than silently emitting "null" — a corrupt canonical
            // form is worse than a hard failure at this layer.
            throw std::invalid_argument(
                "jcs_serialize: unsupported nlohmann::json value_t ("
                + std::to_string(static_cast<int>(value.type())) + ")");
            break;
    }

    return out;
}

// ── jcs_sha256_hex ───────────────────────────────────────────────────────────
// Compute SHA-256(jcs_serialize(value)) via Apple CommonCrypto.
// Returns exactly 64 lowercase hexadecimal characters.

std::string jcs_sha256_hex(const json& value) {
    std::string canonical = jcs_serialize(value);

    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; // 32 bytes
    CC_SHA256(
        canonical.data(),
        static_cast<CC_LONG>(canonical.size()),
        digest
    );

    std::ostringstream hex;
    hex << std::hex << std::setfill('0');
    for (unsigned char b : digest) {
        hex << std::setw(2) << static_cast<unsigned>(b);
    }
    return hex.str();
}

} // namespace sscope

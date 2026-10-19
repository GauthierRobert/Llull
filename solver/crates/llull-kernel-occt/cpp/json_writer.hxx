// Minimal JSON text writer for the query facade (queries.cxx, exchange.cxx): the C++ side answers a query as JSON text that Rust
// parses once (serde_json, float_roundtrip), so the bridge stays a handful of functions and Rust never sees OCCT classes.
// Numbers are written in their shortest round-trip form (std::to_chars), so a double crosses the bridge bit-exact; a non-finite
// number becomes null, like JSON.stringify.
#pragma once

#include <charconv>
#include <cmath>
#include <string>

#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

namespace llull {

class JsonWriter {
 public:
  JsonWriter &begin_object() { return open('{'); }
  JsonWriter &end_object() { return close('}'); }
  JsonWriter &begin_array() { return open('['); }
  JsonWriter &end_array() { return close(']'); }

  JsonWriter &key(const char *name) {
    separate();
    text_ += '"';
    text_ += name;
    text_ += "\":";
    pending_value_ = true;
    return *this;
  }

  JsonWriter &number(double value) {
    separate();
    if (!std::isfinite(value)) {
      text_ += "null";
      return *this;
    }
    if (value == 0) value = 0;  // -0 prints as 0, like JSON.stringify
    char buffer[32];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
    text_.append(buffer, result.ptr);
    return *this;
  }

  JsonWriter &integer(long long value) {
    separate();
    text_ += std::to_string(value);
    return *this;
  }

  JsonWriter &boolean(bool value) {
    separate();
    text_ += value ? "true" : "false";
    return *this;
  }

  JsonWriter &null() {
    separate();
    text_ += "null";
    return *this;
  }

  JsonWriter &string(const std::string &value) {
    separate();
    text_ += '"';
    for (const char raw : value) {
      const auto c = static_cast<unsigned char>(raw);
      if (c == '"' || c == '\\') {
        text_ += '\\';
        text_ += raw;
      } else if (c == '\n') {
        text_ += "\\n";
      } else if (c == '\r') {
        text_ += "\\r";
      } else if (c == '\t') {
        text_ += "\\t";
      } else if (c < 0x20) {
        static const char *hex = "0123456789abcdef";
        text_ += "\\u00";
        text_ += hex[c >> 4];
        text_ += hex[c & 15];
      } else {
        text_ += raw;
      }
    }
    text_ += '"';
    return *this;
  }

  JsonWriter &vec3(double x, double y, double z) { return begin_array().number(x).number(y).number(z).end_array(); }
  JsonWriter &point(const gp_Pnt &p) { return vec3(p.X(), p.Y(), p.Z()); }
  JsonWriter &direction(const gp_Dir &d) { return vec3(d.X(), d.Y(), d.Z()); }
  JsonWriter &vector(const gp_Vec &v) { return vec3(v.X(), v.Y(), v.Z()); }

  const std::string &text() const { return text_; }

 private:
  JsonWriter &open(char bracket) {
    separate();
    text_ += bracket;
    first_ = true;
    return *this;
  }

  JsonWriter &close(char bracket) {
    text_ += bracket;
    first_ = false;
    return *this;
  }

  void separate() {
    if (pending_value_) {
      pending_value_ = false;
      first_ = false;
      return;
    }
    if (!first_ && !text_.empty()) text_ += ',';
    first_ = false;
  }

  std::string text_;
  bool first_ = true;
  bool pending_value_ = false;
};

}  // namespace llull

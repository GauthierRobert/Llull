// Part 21 text side of the PMI reader (XCH 04): the links of a STEP file's PMI followed in the text itself, for what the STEPCAFControl reader cannot bind
// (a magnitude written as a complex record, datum features identified through ITEM_IDENTIFIED_REPRESENTATION_USAGE, features derived from other
// features). Independent of OCCT classes: records are indexed once, references are followed by id.
#pragma once

#include <cctype>
#include <cstdlib>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace llull::pmi_text {

// `#id=BODY;` records of a Part 21 text by id; strings ('...' with '' as quote) never end a record.
class Records {
 public:
  explicit Records(const std::string &content) {
    size_t at = 0;
    while (at < content.size()) {
      const size_t hash = content.find('#', at);
      if (hash == std::string::npos) break;
      size_t digits = hash + 1;
      while (digits < content.size() && std::isdigit(static_cast<unsigned char>(content[digits]))) ++digits;
      size_t equals = digits;
      while (equals < content.size() && std::isspace(static_cast<unsigned char>(content[equals]))) ++equals;
      if (digits == hash + 1 || equals >= content.size() || content[equals] != '=') {
        at = hash + 1;
        continue;
      }
      bool in_string = false;
      size_t end = equals + 1;
      for (; end < content.size(); ++end) {
        if (content[end] == '\'') in_string = !in_string;
        else if (content[end] == ';' && !in_string) break;
      }
      by_id_[std::stol(content.substr(hash + 1, digits - hash - 1))] = content.substr(equals + 1, end - equals - 1);
      at = end + 1;
    }
  }

  const std::string &get(long id) const {
    static const std::string none;
    const auto found = by_id_.find(id);
    return found == by_id_.end() ? none : found->second;
  }

  const std::unordered_map<long, std::string> &all() const { return by_id_; }

 private:
  std::unordered_map<long, std::string> by_id_;
};

// `text` without its quoted strings (a name that looks like a reference or a keyword never counts).
inline std::string without_strings(const std::string &text) {
  std::string out;
  bool in_string = false;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '\'') {
      in_string = !in_string;
      out += '\'';
    } else if (!in_string) out += text[i];
  }
  return out;
}

// The last quoted string of a record (a DATUM's identification), unescaped.
inline std::string last_string(const std::string &text) {
  std::string last, current;
  bool in_string = false;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '\'') {
      if (in_string && i + 1 < text.size() && text[i + 1] == '\'') {
        current += '\'';
        ++i;
      } else if (in_string) {
        last = current;
        current.clear();
        in_string = false;
      } else in_string = true;
    } else if (in_string) current += text[i];
  }
  return last;
}

// Every `#id` reference of `text` outside strings, in order.
inline std::vector<long> references(const std::string &text) {
  std::vector<long> found;
  const std::string bare = without_strings(text);
  for (size_t i = 0; i < bare.size(); ++i) {
    if (bare[i] != '#') continue;
    size_t end = i + 1;
    while (end < bare.size() && std::isdigit(static_cast<unsigned char>(bare[end]))) ++end;
    if (end > i + 1) found.push_back(std::stol(bare.substr(i + 1, end - i - 1)));
    i = end - 1;
  }
  return found;
}

// The references inside the parentheses that follow `keyword` (a whole entity name) in `text`; empty when the keyword is absent.
inline std::vector<long> arguments_of(const std::string &text, const std::string &keyword) {
  const std::string bare = without_strings(text);
  size_t at = 0;
  while ((at = bare.find(keyword + "(", at)) != std::string::npos) {
    if (at == 0 || !(std::isalnum(static_cast<unsigned char>(bare[at - 1])) || bare[at - 1] == '_')) {
      int depth = 0;
      size_t end = at + keyword.size();
      for (; end < bare.size(); ++end) {
        if (bare[end] == '(') ++depth;
        else if (bare[end] == ')' && --depth == 0) break;
      }
      return references(bare.substr(at + keyword.size(), end - at - keyword.size()));
    }
    at += keyword.size();
  }
  return {};
}

inline bool has_entity(const std::string &text, const std::string &keyword) {
  const std::string bare = without_strings(text);
  size_t at = 0;
  while ((at = bare.find(keyword + "(", at)) != std::string::npos) {
    if (at == 0 || !(std::isalnum(static_cast<unsigned char>(bare[at - 1])) || bare[at - 1] == '_')) return true;
    at += keyword.size();
  }
  return false;
}

inline double unit_factor_mm(const Records &records, long unit_id, int depth = 0) {
  const std::string &record = records.get(unit_id);
  if (record.empty() || depth > 3) return 1.0;
  if (const size_t si = record.find("SI_UNIT("); si != std::string::npos) {
    const size_t comma = record.find(',', si);
    const std::string prefix = comma == std::string::npos ? "" : record.substr(si + 8, comma - si - 8);
    if (prefix.find("MILLI") != std::string::npos) return 1.0;
    if (prefix.find("CENTI") != std::string::npos) return 10.0;
    if (prefix.find("MICRO") != std::string::npos) return 1e-3;
    if (prefix.find("KILO") != std::string::npos) return 1e6;
    return prefix.find('$') != std::string::npos ? 1000.0 : 1.0;
  }
  if (const size_t conversion = record.find("CONVERSION_BASED_UNIT("); conversion != std::string::npos) {
    if (record.find("'INCH'") != std::string::npos || record.find("'inch'") != std::string::npos) return 25.4;
    if (record.find("'FOOT'") != std::string::npos) return 304.8;
    const std::vector<long> inside = arguments_of(record, "CONVERSION_BASED_UNIT");
    if (!inside.empty()) {
      const std::string &factor = records.get(inside.front());
      if (const size_t open = factor.find("LENGTH_MEASURE("); open != std::string::npos) {
        const std::vector<long> of = references(factor);
        return std::strtod(factor.c_str() + open + 15, nullptr) * (of.empty() ? 1.0 : unit_factor_mm(records, of.back(), depth + 1));
      }
    }
  }
  return 1.0;
}

// A length measure record (`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.05), #unit)`, also inside a complex record) in millimetres.
inline bool length_mm(const Records &records, long measure_id, double &value) {
  const std::string &record = records.get(measure_id);
  const size_t number = record.find("LENGTH_MEASURE(");
  if (number == std::string::npos) return false;
  value = std::strtod(record.c_str() + number + 15, nullptr);
  const std::vector<long> of = references(record);
  value *= of.empty() ? 1.0 : unit_factor_mm(records, of.back());
  return true;
}

// ---- the link graph of the PMI -------------------------------------------------------------------------------------------------------------

struct Graph {
  explicit Graph(const Records &source) : records(source) {
    for (const auto &entry : records.all()) {
      const std::string &text = entry.second;
      if (has_entity(text, "SHAPE_ASPECT_RELATIONSHIP") || has_entity(text, "SHAPE_ASPECT_DERIVING_RELATIONSHIP")) {
        const std::vector<long> refs = arguments_of(text, has_entity(text, "SHAPE_ASPECT_RELATIONSHIP") ? "SHAPE_ASPECT_RELATIONSHIP" : "SHAPE_ASPECT_DERIVING_RELATIONSHIP");
        if (refs.size() >= 2) {
          (has_entity(text, "SHAPE_ASPECT_DERIVING_RELATIONSHIP") ? derived : related)[refs[refs.size() - 2]].push_back(refs.back());
          if (!has_entity(text, "SHAPE_ASPECT_DERIVING_RELATIONSHIP")) relating_of[refs.back()].push_back(refs[refs.size() - 2]);
        }
      } else if (has_entity(text, "ITEM_IDENTIFIED_REPRESENTATION_USAGE") || has_entity(text, "GEOMETRIC_ITEM_SPECIFIC_USAGE")) {
        const std::vector<long> refs = references(text);
        // (definition, used representation, items...)
        if (refs.size() >= 3) items[refs[0]].insert(items[refs[0]].end(), refs.begin() + 2, refs.end());
      }
    }
  }

  // Item ids (faces, edges, annotation) identified by `aspect`, through its children and the aspects it derives from.
  void items_of(long aspect, std::set<long> &out, std::set<long> &seen, int depth = 0) const {
    if (depth > 8 || !seen.insert(aspect).second) return;
    const std::string &text = records.get(aspect);
    if (has_entity(text, "PLACED_DATUM_TARGET_FEATURE") || has_entity(text, "DATUM_TARGET")) return;
    if (const auto found = items.find(aspect); found != items.end()) out.insert(found->second.begin(), found->second.end());
    if (const auto children = related.find(aspect); children != related.end())
      for (const long child : children->second)
        if (!has_entity(records.get(child), "DATUM")) items_of(child, out, seen, depth + 1);
    if (const auto sources = derived.find(aspect); sources != derived.end())
      for (const long source : sources->second) items_of(source, out, seen, depth + 1);
  }

  const Records &records;
  std::unordered_map<long, std::vector<long>> related;     // aspect -> aspects it relates to (composites, groups)
  std::unordered_map<long, std::vector<long>> relating_of;  // aspect -> aspects that relate to it
  std::unordered_map<long, std::vector<long>> derived;     // aspect -> aspects it derives from
  std::unordered_map<long, std::vector<long>> items;       // aspect -> item ids its usages identify
};

}  // namespace llull::pmi_text

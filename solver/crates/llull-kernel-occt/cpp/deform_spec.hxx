// The flat numeric spec of a `deform` recipe node (01 DEF, TECHNICAL_SPEC §5.6) and its parser, shared by the warp and the point probes.
#pragma once

#include <string>

#include "llull-kernel-occt/cpp/deform_laws.hxx"
#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

// The deformation described by `spec`; false (with `why`) for a malformed spec.
bool parse_spec(rust::Slice<const double> spec, deform::Warp &warp, double &tolerance, bool &preserve, std::string &why);

}  // namespace llull

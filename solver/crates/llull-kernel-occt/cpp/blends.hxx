// Blend support (BLD M0): the radius-law loader shared by fillet_laws and the failure diagnostics of the fillet build (LawFillet).
#pragma once

#include <cstddef>
#include <cstdint>

#include <TopTools_IndexedMapOfShape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"
#include "llull-kernel-occt/cpp/law_fillet.hxx"

namespace llull {

// Numbers before the control points of one law in the flat layout.
constexpr size_t kLawHeader = 4;

// Adds the edges `edges` (indices into `unique`) to `maker`, edge k with its law from `laws`: size, size_end (NaN = constant), mode (0 smooth
// interpolation through the points, 1 exact straight pieces, 2 the monotone C1 cubic), n, then n (t, size) pairs. False when an index or the law data is out of range. `lenient` skips an edge OCCT refuses to add (seam, degenerate), like
// round_edges; otherwise the Standard_Failure propagates.
bool add_fillet_laws(LawFillet &maker, const TopTools_IndexedMapOfShape &unique, rust::Slice<const uint32_t> edges,
                     rust::Slice<const double> laws, bool lenient = false);

// Whether a straight or monotone law of `laws` (same layout) has an interior node: its radius then has a C0 (straight) or C1 (monotone) knot, which the fixed Gauss rule of BRepGProp
// integrates wrongly (mass properties and face areas of the result use the adaptive rule: Shape::refined_mass).
bool has_straight_kink(rust::Slice<const double> laws);

}  // namespace llull

// Blend support (BLD M0): the radius-law loader shared by fillet_laws and the failure diagnostics of BRepFilletAPI_MakeFillet.
#pragma once

#include <cstdint>

#include <BRepFilletAPI_MakeFillet.hxx>
#include <TopTools_IndexedMapOfShape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

// Adds the edges `edges` (indices into `unique`) to `maker`, edge k with its law from `laws`: size, size_end (NaN = constant), n, then n
// (t, size) pairs. False when an index or the law data is out of range. `lenient` skips an edge OCCT refuses to add (seam, degenerate), like
// round_edges; otherwise the Standard_Failure propagates.
bool add_fillet_laws(BRepFilletAPI_MakeFillet &maker, const TopTools_IndexedMapOfShape &unique, rust::Slice<const uint32_t> edges,
                     rust::Slice<const double> laws, bool lenient = false);

}  // namespace llull

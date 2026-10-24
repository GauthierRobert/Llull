// Exact space deformation of a B-rep (01 DEF M2, TECHNICAL_SPEC §5.6): every face and edge is re-approximated as a B-spline of the deformed
// geometry within a tolerance, topology unchanged. Shares `Shape` and the exception-to-Err trycatch with facade.hxx.
#pragma once

#include <memory>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

// The warp of `shape` described by `spec` (layout in deform.cxx: law kind, tolerance, frame, region, law numbers). Null when the deformation is
// refused (bad spec, an approximation above the tolerance, an invalid or self-intersecting result); `warp_report` then says why.
std::unique_ptr<Shape> warp_shape(const Shape &shape, rust::Slice<const double> spec);

// JSON report of the last `warp_shape` call: { ok, code, message, maxError, faces, split, edges, ... } (the sidecar is single threaded).
rust::String warp_report();

// The law of `spec` at `points` (xyz triples): the deformed points then, per point, det J by central differences; used by the parity test
// against validation/data/point_vectors.json (TR-DEF-04).
rust::Vec<double> warp_points(rust::Slice<const double> spec, rust::Slice<const double> points);

}  // namespace llull

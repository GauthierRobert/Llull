// Narrow C++ facade over Netgen (nglib + ngcore, LGPL-2.1, linked dynamically) and the OCCT it meshes, for the FE mesher llull-mesh
// (docs/decisions/NG1-netgen-mesher.md). Rust sees an opaque Shape and coarse operations, never a Netgen or OCCT class.
//
// Numbering: a Shape's faces, edges and solids are 1-based and follow Netgen's own maps (OCCGeometry fmap / emap / somap), so a mesh
// element's face or edge number IS the B-rep face / edge of the Shape it came from.
// Every C++ throw (Netgen's ngcore::Exception, OCCT's Standard_Failure) comes back to Rust as an Err (trycatch below).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <Standard_Failure.hxx>
#include <TopoDS_Shape.hxx>

#include "rust/cxx.h"

namespace rust {
namespace behavior {
template <typename Try, typename Fail>
static void trycatch(Try &&func, Fail &&fail) noexcept try {
  func();
} catch (const Standard_Failure &error) {
  std::string message = std::string(error.DynamicType()->Name()) + ": " +
                        (error.GetMessageString() != nullptr ? error.GetMessageString() : "");
  fail(message.c_str());
} catch (const std::exception &error) {
  fail(error.what());
} catch (...) {
  fail("unknown C++ exception");
}
}  // namespace behavior
}  // namespace rust

namespace netgen {
class OCCGeometry;
}

namespace llull_netgen {

struct MeshParams;
struct Sizes;
struct MeshData;

class Shape {
 public:
  explicit Shape(const TopoDS_Shape &shape);
  ~Shape();

  int32_t solid_count() const;
  int32_t face_count() const;
  int32_t edge_count() const;
  // Faces bounding solid `solid`, edges bounding face `face` (1-based, ascending, no repeats).
  rust::Vec<int32_t> solid_faces(int32_t solid) const;
  rust::Vec<int32_t> face_edges(int32_t face) const;
  // Indices of the input shapes a solid (fragment) or face (planar_faces) came from; empty for a plain shape.
  rust::Vec<int32_t> owners(int32_t item) const;
  // min xyz, max xyz of the exact geometry.
  rust::Vec<double> bounds() const;
  double face_area(int32_t face) const;
  rust::Vec<double> face_centroid(int32_t face) const;
  // Distance from (x, y, z) to the TRIMMED face, then the closest point on it: [d, cx, cy, cz].
  rust::Vec<double> face_distance(int32_t face, double x, double y, double z) const;
  double edge_distance(int32_t edge, double x, double y, double z) const;
  // Radius of a cylinder face, minor radius of a torus face, 0 for every other surface.
  double face_radius(int32_t face) const;
  // Points over a face / along an edge no further apart than `spacing` (x, y, z triples): where a local size applies.
  rust::Vec<double> sample_face(int32_t face, double spacing) const;
  rust::Vec<double> sample_edge(int32_t edge, double spacing) const;
  // The shape without faces `faces` (OCCT defeaturing).
  std::unique_ptr<Shape> defeatured(rust::Slice<const int32_t> faces) const;

  TopoDS_Shape shape;
  std::shared_ptr<netgen::OCCGeometry> geometry;
  std::vector<std::vector<int32_t>> owner_lists;
};

// A list of shapes to fragment together (conformal bonding).
class ShapeList {
 public:
  std::vector<TopoDS_Shape> shapes;
};

rust::String netgen_version();
rust::String occt_version();

// STEP file -> shape, every coordinate multiplied by `scale` about the origin.
std::unique_ptr<Shape> read_step(rust::Str path, double scale);
// Planar faces from polygon loops: `coords` (x, y, z per vertex), `loop_sizes` (vertices per loop), `face_loops` (loops per face, outer
// first); all faces fragmented together (fuzzy tolerance `fuzzy`) so touching faces share edges. owners(face) = input face indices.
std::unique_ptr<Shape> planar_faces(rust::Slice<const double> coords, rust::Slice<const uint32_t> loop_sizes,
                                    rust::Slice<const uint32_t> face_loops, double fuzzy);
std::unique_ptr<ShapeList> new_shape_list();
void push_shape(ShapeList &list, const Shape &shape);
// The solids of every listed shape fragmented together (general fuse): touching solids share faces. owners(solid) = list indices.
std::unique_ptr<Shape> fragment(const ShapeList &list);

// Tetrahedral (or, with params.surface_only, surface) mesh of a shape; first order, Netgen point numbers 1..n.
MeshData mesh_shape(const Shape &shape, const MeshParams &params, const Sizes &sizes);
// Tetrahedral mesh of a closed triangulated surface (x, y, z of 3 corners per facet).
MeshData mesh_stl(rust::Slice<const double> facets, const MeshParams &params, const Sizes &sizes);

}  // namespace llull_netgen

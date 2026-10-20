// Persistent face / edge names of the native kernel (SC-N1, docs/decisions/SC1-solidcraft-parity.md). Every Shape carries one name per
// distinct face (TopExp::MapShapes order, the index rule of queries.hxx). A primitive names its faces by construction role (box "x+",
// cylinder "side", prism "side.<k>" for profile segment k, "cap.start" / "cap.end"); every later operation carries names forward with
// OCCT's own history (BRepTools_History of the algorithm: Modified / Generated / IsRemoved), never by re-matching geometry:
//   - a face modified or kept by the operation keeps its name (a face split in two keeps it twice: the host reports REF_SPLIT);
//   - a face generated from an input edge is "<role>(<edge name>)" (fillet "blend(...)", chamfer "chamfer(...)", feature cut tools);
//   - a face generated from an input vertex is "<role>(v:<edge names>)" (fillet corner patches);
//   - offset operations (shell) name the new inner wall of face N "N~inner".
// Edges are named from the faces that meet there: "e(A|B)" (names sorted), "#k" ordering edges with the same pair by mid point.
// Rust prefixes leaf names with the entity id (`prefixed`), so a name reads "<entity>:<role>" and survives every upstream edit that
// keeps the entity and the role.
#pragma once

#include <string>
#include <vector>

#include <BRepTools_History.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Shape.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {
namespace naming {

// A shape with its face names, the input of a naming step.
struct Named {
  TopoDS_Shape shape;
  std::vector<std::string> names;
};

// How the images of a modified face are named.
enum class Images {
  Same,    // every image keeps the face's name
  Offset,  // an image off the face's own surface is the face's offset wall: "<name>~inner"
};

// Face names of `shape`, aligned with its distinct faces; "f<k>" for a face that carries none (blobs, sewn meshes).
std::vector<std::string> face_names(const Shape &shape);
Named named(const Shape &shape);

// Edge names aligned with the distinct edges of `shape`, built from the names of the faces that meet at each edge.
std::vector<std::string> edge_names(const TopoDS_Shape &shape, const std::vector<std::string> &faces);

// Names of the faces of `result`, carried from `inputs` through `history`; `generated` is the role of faces generated from edges /
// vertices (and, with Images::Offset, from faces).
std::vector<std::string> inherit(const TopoDS_Shape &result, const std::vector<Named> &inputs, const Handle(BRepTools_History) & history,
                                 const std::string &generated, Images images = Images::Same);

// The history of a BRepBuilderAPI_MakeShape-like algorithm over its argument shapes.
template <class Algo>
Handle(BRepTools_History) history_of(const std::vector<Named> &inputs, Algo &algo) {
  TopTools_ListOfShape arguments;
  for (const Named &input : inputs) arguments.Append(input.shape);
  return new BRepTools_History(arguments, algo);
}

// `shape` wrapped with `names` (null when the shape is null).
std::unique_ptr<Shape> wrap_named(const TopoDS_Shape &shape, std::vector<std::string> names);

// Construction roles of a freshly built primitive (local frame, before placement): planar faces by outward normal ("x+", "z-",
// cylinder / cone "top" / "bottom" when `axial`), curved faces "side" (cylinder, cone) or "surface" (sphere, torus).
std::vector<std::string> primitive_roles(const TopoDS_Shape &shape, bool axial);

// Roles of a prism / revolution of `profile` (a face): the face generated from the k-th edge of the profile's wires (outer wire
// first, wire explorer order) is "<side>.<k>", the start / end faces "cap.start" / "cap.end".
template <class Maker>
std::vector<std::string> swept_roles(const TopoDS_Shape &result, const TopoDS_Shape &profile, Maker &maker, const char *side);

}  // namespace naming
}  // namespace llull

#include "llull-kernel-occt/cpp/naming_swept.hxx"

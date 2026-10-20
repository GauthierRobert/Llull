// Face operations of the native kernel (SC-F1): draft (BRepOffsetAPI_DraftAngle), push-pull (prism of the face + boolean) and face split
// (BRepFeat_SplitShape along a plane section). Each keeps the persistent face names of naming.hxx.
#include "llull-kernel-occt/cpp/features.hxx"

#include <cmath>
#include <stdexcept>

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepFeat_SplitShape.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pln.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/src/features.rs.h"

namespace llull {

namespace {

TopTools_IndexedMapOfShape faces_of(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_FACE, map);
  return map;
}

gp_Pnt point3(rust::Slice<const double> values) {
  if (values.size() != 3) throw std::invalid_argument("point: need 3 components");
  return gp_Pnt(values[0], values[1], values[2]);
}

gp_Dir dir3(rust::Slice<const double> values) {
  if (values.size() != 3) throw std::invalid_argument("direction: need 3 components");
  return gp_Dir(values[0], values[1], values[2]);
}

// Outward unit normal of a planar face of a solid (orientation applied); throws on a curved face.
gp_Dir outward_normal(const TopoDS_Face &face) {
  const BRepAdaptor_Surface surface(face, Standard_True);
  if (surface.GetType() != GeomAbs_Plane) throw std::invalid_argument("push-pull: the face is not planar");
  gp_Dir normal = surface.Plane().Axis().Direction();
  if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
  return normal;
}

// A point on `face` at the middle of its parameter box.
gp_Pnt mid_point(const TopoDS_Face &face) {
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  return BRepAdaptor_Surface(face, Standard_True).Value((u0 + u1) / 2, (v0 + v1) / 2);
}

}  // namespace

std::unique_ptr<Shape> draft_faces(const Shape &shape, rust::Slice<const uint32_t> faces, double angle, rust::Slice<const double> pull,
                                   rust::Slice<const double> origin, rust::Slice<const double> normal) {
  const TopTools_IndexedMapOfShape all = faces_of(shape.shape);
  BRepOffsetAPI_DraftAngle maker(shape.shape);
  const gp_Pln neutral(point3(origin), dir3(normal));
  for (uint32_t index : faces) {
    if (static_cast<int>(index) >= all.Extent()) return nullptr;
    maker.Add(TopoDS::Face(all(static_cast<int>(index) + 1)), dir3(pull), angle, neutral, Standard_True);
    if (!maker.AddDone()) return nullptr;
  }
  maker.Build();
  if (!maker.IsDone()) return nullptr;
  const TopoDS_Shape result = maker.Shape();
  const std::vector<naming::Named> inputs{naming::named(shape)};
  return naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), "draft"));
}

std::unique_ptr<Shape> push_pull(const Shape &shape, uint32_t face_index, double distance) {
  const TopTools_IndexedMapOfShape all = faces_of(shape.shape);
  if (static_cast<int>(face_index) >= all.Extent() || distance == 0 || !std::isfinite(distance)) return nullptr;
  const TopoDS_Face face = TopoDS::Face(all(static_cast<int>(face_index) + 1));
  const gp_Dir normal = outward_normal(face);
  TopoDS_Face profile = face;
  profile.Orientation(TopAbs_FORWARD);
  BRepPrimAPI_MakePrism maker(profile, gp_Vec(normal) * distance, Standard_False, Standard_True);
  const TopoDS_Shape prism = maker.Shape();
  if (prism.IsNull()) return nullptr;
  // The prism's far cap is the moved face: it keeps the face's name; its sides are "<face>~side.<k>", its near cap "<face>~base".
  const std::string name = naming::face_names(shape)[face_index];
  std::vector<std::string> roles = naming::swept_roles(prism, profile, maker, "side");
  for (std::string &role : roles) role = role == "cap.end" ? name : name + "~" + (role == "cap.start" ? std::string("base") : role);
  Shape tool(prism);
  tool.names = std::move(roles);
  return boolean_op(shape, tool, distance > 0 ? 0 : 1, true);
}

std::unique_ptr<Shape> split_faces(const Shape &shape, rust::Slice<const uint32_t> faces, rust::Slice<const double> origin,
                                   rust::Slice<const double> normal) {
  const TopTools_IndexedMapOfShape all = faces_of(shape.shape);
  const gp_Pln plane(point3(origin), dir3(normal));
  BRepFeat_SplitShape splitter(shape.shape);
  int cuts = 0;
  for (uint32_t index : faces) {
    if (static_cast<int>(index) >= all.Extent()) return nullptr;
    const TopoDS_Face face = TopoDS::Face(all(static_cast<int>(index) + 1));
    BRepAlgoAPI_Section section(face, plane, Standard_False);
    section.ComputePCurveOn1(Standard_True);
    section.Approximation(Standard_True);
    section.Build();
    if (!section.IsDone()) return nullptr;
    for (TopExp_Explorer edges(section.Shape(), TopAbs_EDGE); edges.More(); edges.Next(), ++cuts)
      splitter.Add(TopoDS::Edge(edges.Current()), face);
  }
  if (cuts == 0) return nullptr;
  splitter.Build();
  if (!splitter.IsDone()) return nullptr;
  const TopoDS_Shape result = splitter.Shape();
  const std::vector<naming::Named> inputs{naming::named(shape)};
  std::vector<std::string> names = naming::inherit(result, inputs, naming::history_of(inputs, splitter), "split");
  // The two pieces of a split face are told apart by side of the plane, so neither reads as a split (REF_SPLIT) reference later.
  const TopTools_IndexedMapOfShape pieces = faces_of(result);
  const std::vector<std::string> before = naming::face_names(shape);
  for (uint32_t index : faces) {
    const TopTools_ListOfShape &images = splitter.Modified(all(static_cast<int>(index) + 1));
    if (images.Extent() < 2) continue;
    for (TopTools_ListIteratorOfListOfShape it(images); it.More(); it.Next()) {
      const int piece = pieces.FindIndex(it.Value());
      if (piece <= 0) continue;
      const gp_Vec offset(plane.Location(), mid_point(TopoDS::Face(it.Value())));
      const bool above = offset.Dot(gp_Vec(plane.Axis().Direction())) > 0;
      names[static_cast<size_t>(piece - 1)] = before[index] + (above ? "~above" : "~below");
    }
  }
  return naming::wrap_named(result, std::move(names));
}

}  // namespace llull

// One closed solid from the shells that sewing a blended solid's faces gives (BLD §13.17): the outer shell and, when the source had voids, their shells as inner shells of the same solid.
#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>

namespace llull {
namespace blend {

// The solid of the shells of `sewn`: one shell is the solid; with several, the one of the largest volume is the outer shell and every other must lie INSIDE it (a void: its shell is
// reversed so that its normals point into the void). A shell outside the outer one is a second body, which a single solid cannot hold: null with the reason in `why`.
// The solid is oriented (positive volume) but not checked: the caller runs BRepCheck_Analyzer.
inline TopoDS_Solid solid_of_shells(const TopoDS_Shape &sewn, std::string &why) {
  struct Piece {
    TopoDS_Solid solid;
    double volume;
  };
  std::vector<TopoDS_Shell> shells;
  if (sewn.ShapeType() == TopAbs_SHELL) shells.push_back(TopoDS::Shell(sewn));
  else
    for (TopExp_Explorer it(sewn, TopAbs_SHELL); it.More(); it.Next()) shells.push_back(TopoDS::Shell(it.Current()));
  // a closed face (a sphere pocket is one face) sews into a face of its own, not a shell: it is a shell of one face
  TopTools_IndexedMapOfShape in_shells;
  for (const TopoDS_Shell &shell : shells) TopExp::MapShapes(shell, TopAbs_FACE, in_shells);
  for (TopExp_Explorer it(sewn, TopAbs_FACE); it.More(); it.Next()) {
    if (in_shells.Contains(it.Current())) continue;
    BRep_Builder maker;
    TopoDS_Shell alone;
    maker.MakeShell(alone);
    maker.Add(alone, it.Current());
    shells.push_back(alone);
  }
  if (shells.empty()) {
    why = "the sewn faces hold no closed shell";
    return TopoDS_Solid();
  }
  std::vector<Piece> pieces;
  for (const TopoDS_Shell &shell : shells) {
    BRepBuilderAPI_MakeSolid maker(shell);
    TopoDS_Solid solid = maker.Solid();
    BRepLib::OrientClosedSolid(solid);
    GProp_GProps properties;
    BRepGProp::VolumeProperties(solid, properties);
    pieces.push_back({solid, properties.Mass()});
  }
  if (pieces.size() == 1) return pieces[0].solid;
  const auto outer = std::max_element(pieces.begin(), pieces.end(), [](const Piece &a, const Piece &b) { return a.volume < b.volume; });
  const auto shell_of = [](const TopoDS_Solid &solid) {
    TopExp_Explorer it(solid, TopAbs_SHELL);
    return TopoDS::Shell(it.Current());
  };
  BRep_Builder builder;
  TopoDS_Solid result;
  builder.MakeSolid(result);
  builder.Add(result, shell_of(outer->solid));
  for (auto piece = pieces.begin(); piece != pieces.end(); ++piece) {
    if (piece == outer) continue;
    const TopoDS_Shell inner = shell_of(piece->solid);
    TopExp_Explorer vertices(inner, TopAbs_VERTEX);
    if (!vertices.More()) {
      why = "a shell of the sewn faces has no vertex";
      return TopoDS_Solid();
    }
    BRepClass3d_SolidClassifier classifier(outer->solid, BRep_Tool::Pnt(TopoDS::Vertex(vertices.Current())), 1e-7);
    if (classifier.State() != TopAbs_IN) {
      why = "the solid has a second body outside the first (a solid holds one outer shell and its voids)";
      return TopoDS_Solid();
    }
    builder.Add(result, inner.Reversed());
  }
  return result;
}

}  // namespace blend
}  // namespace llull

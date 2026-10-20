// Template part of naming.hxx: construction roles of a swept primitive (BRepPrimAPI_MakePrism / BRepPrimAPI_MakeRevol).
#pragma once

#include <string>
#include <vector>

#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>

namespace llull {
namespace naming {

template <class Maker>
std::vector<std::string> swept_roles(const TopoDS_Shape &result, const TopoDS_Shape &profile, Maker &maker, const char *side) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(result, TopAbs_FACE, faces);
  std::vector<std::string> roles(static_cast<size_t>(faces.Extent()));
  const auto assign = [&](const TopoDS_Shape &face, const std::string &role) {
    const int index = faces.FindIndex(face);
    if (index > 0 && roles[static_cast<size_t>(index - 1)].empty()) roles[static_cast<size_t>(index - 1)] = role;
  };
  const TopoDS_Face face = TopoDS::Face(profile);
  std::vector<TopoDS_Wire> wires;
  const TopoDS_Wire outer = BRepTools::OuterWire(face);
  if (!outer.IsNull()) wires.push_back(outer);
  for (TopExp_Explorer explorer(face, TopAbs_WIRE); explorer.More(); explorer.Next())
    if (!explorer.Current().IsSame(outer)) wires.push_back(TopoDS::Wire(explorer.Current()));
  int k = 0;
  for (const TopoDS_Wire &wire : wires) {
    for (BRepTools_WireExplorer edges(wire, face); edges.More(); edges.Next(), ++k) {
      const TopTools_ListOfShape &generated = maker.Generated(edges.Current());
      for (TopTools_ListIteratorOfListOfShape it(generated); it.More(); it.Next())
        if (it.Value().ShapeType() == TopAbs_FACE) assign(it.Value(), std::string(side) + "." + std::to_string(k));
    }
  }
  const TopoDS_Shape first = maker.FirstShape();
  const TopoDS_Shape last = maker.LastShape();
  for (TopExp_Explorer explorer(first, TopAbs_FACE); explorer.More(); explorer.Next()) assign(explorer.Current(), "cap.start");
  for (TopExp_Explorer explorer(last, TopAbs_FACE); explorer.More(); explorer.Next()) assign(explorer.Current(), "cap.end");
  return roles;
}

}  // namespace naming
}  // namespace llull

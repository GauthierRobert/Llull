// Persistent face / edge names (SC-N1): see naming.hxx for the rules.
#include "llull-kernel-occt/cpp/naming.hxx"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <tuple>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <cstdio>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

namespace llull {
namespace naming {

namespace {

TopTools_IndexedMapOfShape distinct_of(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, kind, map);
  return map;
}

std::string joined(std::vector<std::string> parts, const char *separator) {
  std::sort(parts.begin(), parts.end());
  parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
  std::string text;
  for (size_t i = 0; i < parts.size(); ++i) text += (i == 0 ? "" : separator) + parts[i];
  return text;
}

// A point on `face` at the middle of its parameter box (on the surface, unlike the area centroid of a curved face).
gp_Pnt point_on(const TopoDS_Face &face) {
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  const BRepAdaptor_Surface surface(face, Standard_True);
  return surface.Value((u0 + u1) / 2, (v0 + v1) / 2);
}

// `image` lies on the surface of `face` (a face trimmed or kept, not offset from it).
bool on_surface_of(const TopoDS_Shape &image, const TopoDS_Shape &face) {
  const gp_Pnt point = point_on(TopoDS::Face(image));
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(TopoDS::Face(face));
  if (surface.IsNull()) return true;
  GeomAPI_ProjectPointOnSurf projection(point, surface);
  if (projection.NbPoints() == 0) return false;
  const double scale = 1 + std::fabs(point.X()) + std::fabs(point.Y()) + std::fabs(point.Z());
  return projection.LowerDistance() <= 1e-7 * scale;
}

// Outward normal of a planar face (orientation applied); null vector for a non-planar face.
gp_Vec planar_normal(const TopoDS_Face &face) {
  const BRepAdaptor_Surface surface(face, Standard_True);
  if (surface.GetType() != GeomAbs_Plane) return gp_Vec(0, 0, 0);
  gp_Vec normal(surface.Plane().Axis().Direction());
  if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
  return normal;
}

std::string axis_role(const gp_Vec &normal) {
  const double components[3] = {normal.X(), normal.Y(), normal.Z()};
  int best = 0;
  for (int k = 1; k < 3; ++k)
    if (std::fabs(components[k]) > std::fabs(components[best])) best = k;
  if (std::fabs(components[best]) < 1 - 1e-9) {
    char text[64];
    std::snprintf(text, sizeof(text), "p(%.3f,%.3f,%.3f)", normal.X(), normal.Y(), normal.Z());
    return text;
  }
  return std::string(1, "xyz"[best]) + (components[best] > 0 ? "+" : "-");
}

std::tuple<long long, long long, long long> rounded_mid(const TopoDS_Edge &edge) {
  if (BRep_Tool::Degenerated(edge)) {
    const gp_Pnt at = BRep_Tool::Pnt(TopExp::FirstVertex(edge, Standard_False));
    return {std::llround(at.X() * 1e6), std::llround(at.Y() * 1e6), std::llround(at.Z() * 1e6)};
  }
  const BRepAdaptor_Curve curve(edge);
  const gp_Pnt mid = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2);
  return {std::llround(mid.X() * 1e6), std::llround(mid.Y() * 1e6), std::llround(mid.Z() * 1e6)};
}

}  // namespace

std::vector<std::string> face_names(const Shape &shape) {
  const int count = distinct_of(shape.shape, TopAbs_FACE).Extent();
  std::vector<std::string> names = shape.names;
  names.resize(static_cast<size_t>(count));
  for (int k = 0; k < count; ++k)
    if (names[static_cast<size_t>(k)].empty()) names[static_cast<size_t>(k)] = "f" + std::to_string(k);
  return names;
}

Named named(const Shape &shape) { return Named{shape.shape, face_names(shape)}; }

std::vector<std::string> edge_names(const TopoDS_Shape &shape, const std::vector<std::string> &faces) {
  const TopTools_IndexedMapOfShape face_map = distinct_of(shape, TopAbs_FACE);
  const TopTools_IndexedMapOfShape edges = distinct_of(shape, TopAbs_EDGE);
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  std::vector<std::string> names(static_cast<size_t>(edges.Extent()));
  std::map<std::string, std::vector<int>> groups;
  for (int e = 1; e <= edges.Extent(); ++e) {
    std::vector<std::string> around;
    const int slot = owners.FindIndex(edges(e));
    if (slot > 0)
      for (TopTools_ListIteratorOfListOfShape it(owners(slot)); it.More(); it.Next()) {
        const int face = face_map.FindIndex(it.Value());
        if (face > 0 && static_cast<size_t>(face) <= faces.size()) around.push_back(faces[static_cast<size_t>(face - 1)]);
      }
    const std::string base = "e(" + joined(around, "|") + ")";
    names[static_cast<size_t>(e - 1)] = base;
    groups[base].push_back(e);
  }
  for (auto &[base, members] : groups) {
    if (members.size() < 2) continue;
    std::sort(members.begin(), members.end(), [&](int a, int b) {
      return rounded_mid(TopoDS::Edge(edges(a))) < rounded_mid(TopoDS::Edge(edges(b)));
    });
    for (size_t k = 0; k < members.size(); ++k) names[static_cast<size_t>(members[k] - 1)] = base + "#" + std::to_string(k + 1);
  }
  return names;
}

std::vector<std::string> inherit(const TopoDS_Shape &result, const std::vector<Named> &inputs, const Handle(BRepTools_History) & history,
                                 const std::string &generated, Images images) {
  const TopTools_IndexedMapOfShape faces = distinct_of(result, TopAbs_FACE);
  std::vector<std::string> names(static_cast<size_t>(faces.Extent()));
  const auto assign = [&](const TopoDS_Shape &face, const std::string &name) {
    if (face.ShapeType() != TopAbs_FACE) return;
    const int index = faces.FindIndex(face);
    if (index > 0 && names[static_cast<size_t>(index - 1)].empty()) names[static_cast<size_t>(index - 1)] = name;
  };
  const auto each = [](const TopTools_ListOfShape &list, const auto &visit) {
    for (TopTools_ListIteratorOfListOfShape it(list); it.More(); it.Next()) visit(it.Value());
  };
  // Kept and modified faces first, so a face never takes a generated name it also inherits.
  for (const Named &input : inputs) {
    const TopTools_IndexedMapOfShape input_faces = distinct_of(input.shape, TopAbs_FACE);
    for (int f = 1; f <= input_faces.Extent(); ++f) {
      const TopoDS_Shape &face = input_faces(f);
      const std::string &name = input.names[static_cast<size_t>(f - 1)];
      if (history.IsNull()) {
        assign(face, name);
        continue;
      }
      if (history->IsRemoved(face)) continue;
      const TopTools_ListOfShape &modified = history->Modified(face);
      if (modified.IsEmpty()) assign(face, name);
      each(modified, [&](const TopoDS_Shape &image) {
        const bool offset = images == Images::Offset && image.ShapeType() == TopAbs_FACE && !on_surface_of(image, face);
        assign(image, offset ? name + "~inner" : name);
      });
    }
  }
  if (history.IsNull()) return names;
  for (const Named &input : inputs) {
    const TopTools_IndexedMapOfShape input_faces = distinct_of(input.shape, TopAbs_FACE);
    for (int f = 1; f <= input_faces.Extent(); ++f) {
      const std::string &name = input.names[static_cast<size_t>(f - 1)];
      each(history->Generated(input_faces(f)), [&](const TopoDS_Shape &image) { assign(image, name + "~" + generated); });
    }
    const std::vector<std::string> input_edges = edge_names(input.shape, input.names);
    const TopTools_IndexedMapOfShape edges = distinct_of(input.shape, TopAbs_EDGE);
    for (int e = 1; e <= edges.Extent(); ++e) {
      const std::string &edge = input_edges[static_cast<size_t>(e - 1)];
      each(history->Generated(edges(e)), [&](const TopoDS_Shape &image) { assign(image, generated + "(" + edge + ")"); });
    }
    TopTools_IndexedDataMapOfShapeListOfShape vertex_edges;
    TopExp::MapShapesAndAncestors(input.shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
    for (int v = 1; v <= vertex_edges.Extent(); ++v) {
      std::vector<std::string> around;
      each(vertex_edges(v), [&](const TopoDS_Shape &edge) {
        const int index = edges.FindIndex(edge);
        if (index > 0) around.push_back(input_edges[static_cast<size_t>(index - 1)]);
      });
      const std::string name = generated + "(v:" + joined(around, ",") + ")";
      each(history->Generated(vertex_edges.FindKey(v)), [&](const TopoDS_Shape &image) { assign(image, name); });
    }
  }
  return names;
}

std::unique_ptr<Shape> wrap_named(const TopoDS_Shape &shape, std::vector<std::string> names) {
  if (shape.IsNull()) return nullptr;
  auto wrapped = std::make_unique<Shape>(shape);
  wrapped->names = std::move(names);
  return wrapped;
}

std::vector<std::string> primitive_roles(const TopoDS_Shape &shape, bool axial) {
  const TopTools_IndexedMapOfShape faces = distinct_of(shape, TopAbs_FACE);
  std::vector<std::string> roles;
  std::map<std::string, int> seen;
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    const gp_Vec normal = planar_normal(face);
    std::string role;
    if (normal.Magnitude() == 0) {
      const GeomAbs_SurfaceType type = BRepAdaptor_Surface(face, Standard_True).GetType();
      role = type == GeomAbs_Cylinder || type == GeomAbs_Cone ? "side" : "surface";
    } else if (axial) {
      role = normal.Z() > 0 ? "top" : "bottom";
    } else {
      role = axis_role(normal);
    }
    const int count = ++seen[role];
    roles.push_back(count == 1 ? role : role + "#" + std::to_string(count));
  }
  return roles;
}

}  // namespace naming
}  // namespace llull

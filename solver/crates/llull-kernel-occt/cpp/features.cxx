// OCCT side of the native kernel's feature operations. Every builder mirrors packages/kernel-occt (opencascade.js, OCCT 7.4):
// occtKernel.ts (roundEdges, blendedUnion, hollow, openShell), occtCurves.ts (segment edges, wires, faces, ThruSections, MakePipe),
// occtPatches.ts (Coons-filled B-spline patches with their poles set, sewn) and occtFeatures.ts (BRepFeat makers).
#include "llull-kernel-occt/cpp/features.hxx"

#include <cmath>
#include <limits>
#include <stdexcept>

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFeat_MakePrism.hxx>
#include <BRepFeat_MakeRevol.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRep_Tool.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GeomFill_BSplineCurves.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>

#include "llull-kernel-occt/src/features.rs.h"

namespace llull {

namespace {

std::unique_ptr<Shape> wrap(const TopoDS_Shape &shape) {
  if (shape.IsNull()) return nullptr;
  return std::make_unique<Shape>(shape);
}

gp_Pnt point_at(rust::Slice<const double> values, size_t offset) {
  if (offset + 3 > values.size()) throw std::invalid_argument("point: out of range");
  return gp_Pnt(values[offset], values[offset + 1], values[offset + 2]);
}

gp_Dir direction_of(rust::Slice<const double> values) {
  if (values.size() != 3) throw std::invalid_argument("direction: need 3 components");
  return gp_Dir(values[0], values[1], values[2]);
}

// Unique sub-shapes in explorer order (IsSame, any orientation): the numbering fillet / chamfer select by (occtTopology.ts).
TopTools_IndexedMapOfShape unique_sub_shapes(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, kind, map);
  return map;
}

// occtKernel.ts validOrNull: OCC fillets can report done yet return a broken solid on which later booleans hang.
TopoDS_Shape valid_or_null(const TopoDS_Shape &shape) {
  BRepCheck_Analyzer check(shape, Standard_True);
  return check.IsValid() ? shape : TopoDS_Shape();
}

// occtCurves.ts segmentEdge: line / circular arc through three points / cubic Bezier; null edge when OCC rejects it.
TopoDS_Edge segment_edge(int type, rust::Slice<const double> chain, size_t offset) {
  if (type == 0) {
    BRepBuilderAPI_MakeEdge maker(point_at(chain, offset), point_at(chain, offset + 3));
    return maker.IsDone() ? maker.Edge() : TopoDS_Edge();
  }
  if (type == 1) {
    GC_MakeArcOfCircle arc(point_at(chain, offset), point_at(chain, offset + 3), point_at(chain, offset + 6));
    if (!arc.IsDone()) return TopoDS_Edge();
    const Handle(Geom_TrimmedCurve) trimmed = arc.Value();
    const Handle(Geom_Curve) curve(trimmed);
    BRepBuilderAPI_MakeEdge maker(curve);
    return maker.IsDone() ? maker.Edge() : TopoDS_Edge();
  }
  TColgp_Array1OfPnt poles(1, 4);
  for (int k = 0; k < 4; ++k) poles.SetValue(k + 1, point_at(chain, offset + 3 * k));
  const Handle(Geom_Curve) bezier = new Geom_BezierCurve(poles);
  BRepBuilderAPI_MakeEdge maker(bezier);
  return maker.IsDone() ? maker.Edge() : TopoDS_Edge();
}

// occtCurves.ts chainWire; null wire when an edge or the wire fails.
TopoDS_Wire chain_wire(rust::Slice<const double> chain) {
  BRepBuilderAPI_MakeWire maker;
  size_t offset = 0;
  while (offset < chain.size()) {
    const int type = static_cast<int>(chain[offset]);
    if (type < 0 || type > 2) throw std::invalid_argument("chain: unknown segment type");
    const TopoDS_Edge edge = segment_edge(type, chain, offset + 1);
    if (edge.IsNull()) return TopoDS_Wire();
    maker.Add(edge);
    offset += 1 + 3 * static_cast<size_t>(type + 2);
  }
  return maker.IsDone() ? maker.Wire() : TopoDS_Wire();
}

// occtCurves.ts circleWire.
TopoDS_Wire circle_wire(const gp_Pnt &center, const gp_Dir &normal, double radius) {
  BRepBuilderAPI_MakeEdge edge(gp_Circ(gp_Ax2(center, normal), radius));
  BRepBuilderAPI_MakeWire wire(edge.Edge());
  return wire.Wire();
}

// occtShapes.ts polygonFace: planar face of the closed polygon (MakeFace OnlyPlane = false).
TopoDS_Shape polygon_face(rust::Slice<const double> polygon) {
  if (polygon.size() < 9 || polygon.size() % 3 != 0) throw std::invalid_argument("polygon: need >= 3 points");
  BRepBuilderAPI_MakePolygon wire;
  for (size_t i = 0; i < polygon.size(); i += 3) wire.Add(point_at(polygon, i));
  wire.Close();
  if (!wire.IsDone()) return TopoDS_Shape();
  BRepBuilderAPI_MakeFace face(wire.Wire(), Standard_False);
  return face.IsDone() ? TopoDS_Shape(face.Face()) : TopoDS_Shape();
}

// occtFaceDistance.ts nearestOn: vertex-to-shape extrema distance; infinity when unsolved.
double nearest_distance(const TopoDS_Shape &target, const gp_Pnt &point) {
  BRepBuilderAPI_MakeVertex vertex(point);
  BRepExtrema_DistShapeShape extrema;
  extrema.LoadS1(vertex.Vertex());
  extrema.LoadS2(target);
  if (!extrema.Perform() || !extrema.IsDone()) return std::numeric_limits<double>::infinity();
  return extrema.Value();
}

// occtKernel.ts closedCavity: OCC returns the offset of a solid with curved faces as a bare shell, which a cut cannot subtract.
TopoDS_Shape closed_cavity(const TopoDS_Shape &skin) {
  if (unique_sub_shapes(skin, TopAbs_SOLID).Extent() > 0) return skin;
  const TopTools_IndexedMapOfShape shells = unique_sub_shapes(skin, TopAbs_SHELL);
  if (shells.Extent() == 0) return skin;
  ShapeFix_Solid fixer;
  return fixer.SolidFromShell(TopoDS::Shell(shells(1)));
}

// occtPatches.ts placeholderBoundaries: the unit square as four straight cubic B-spline curves, end to start.
Handle(Geom_BSplineCurve) placeholder_boundary(int k) {
  const double corners[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
  const double *from = corners[k];
  const double *to = corners[(k + 1) % 4];
  TColgp_Array1OfPnt poles(1, 4);
  for (int i = 0; i < 4; ++i) {
    const double t = i / 3.0;
    poles.SetValue(i + 1, gp_Pnt(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, 0));
  }
  TColStd_Array1OfReal knots(1, 2);
  knots.SetValue(1, 0);
  knots.SetValue(2, 1);
  TColStd_Array1OfInteger multiplicities(1, 2);
  multiplicities.SetValue(1, 4);
  multiplicities.SetValue(2, 4);
  return new Geom_BSplineCurve(poles, knots, multiplicities, 3, Standard_False);
}

// occtPatches.ts patchFace; null face when OCC refuses it.
TopoDS_Shape patch_face(rust::Slice<const double> poles, size_t offset) {
  GeomFill_BSplineCurves filling(placeholder_boundary(0), placeholder_boundary(1), placeholder_boundary(2), placeholder_boundary(3),
                                 GeomFill_CoonsStyle);
  Handle(Geom_BSplineSurface) surface = filling.Surface();
  if (surface.IsNull() || surface->NbUPoles() != 4 || surface->NbVPoles() != 4) return TopoDS_Shape();
  for (int index = 0; index < 16; ++index) surface->SetPole(index / 4 + 1, index % 4 + 1, point_at(poles, offset + 3 * index));
  const Handle(Geom_Surface) asSurface = surface;
  BRepBuilderAPI_MakeFace maker(asSurface, 1e-7);
  return maker.IsDone() ? TopoDS_Shape(maker.Face()) : TopoDS_Shape();
}

// occtPatches.ts sewnSolid: one closed shell or nothing.
TopoDS_Shape sewn_solid(const std::vector<TopoDS_Shape> &faces, double tolerance) {
  BRepBuilderAPI_Sewing sewing(tolerance, Standard_True, Standard_True, Standard_True, Standard_False);
  for (const TopoDS_Shape &face : faces) sewing.Add(face);
  sewing.Perform();
  if (sewing.NbFreeEdges() > 0) return TopoDS_Shape();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) return TopoDS_Shape();
  BRepBuilderAPI_MakeSolid solid;
  int count = 0;
  for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
    solid.Add(TopoDS::Shell(shell.Current()));
    ++count;
  }
  if (count != 1) return TopoDS_Shape();
  solid.Build();
  return solid.IsDone() ? solid.Shape() : TopoDS_Shape();
}

// occtFeatures.ts supportingFace: the planar face of `source` on the frame plane that contains one of the probe points.
TopoDS_Shape supporting_face(const TopoDS_Shape &source, const gp_Pnt &origin, const gp_Dir &normal, rust::Slice<const double> probes) {
  const double parallel = 1 - 1e-9;
  const TopTools_IndexedMapOfShape faces = unique_sub_shapes(source, TopAbs_FACE);
  const gp_Vec frame_origin(origin.XYZ());
  for (int i = 1; i <= faces.Extent(); ++i) {
    const TopoDS_Face face = TopoDS::Face(faces(i));
    BRepAdaptor_Surface adaptor(face, Standard_True);
    if (adaptor.GetType() != GeomAbs_Plane) continue;
    const gp_Ax3 position = adaptor.Plane().Position();
    const gp_Vec surface_normal(position.Direction());
    if (std::fabs(surface_normal.Dot(gp_Vec(normal))) < parallel) continue;
    const gp_Vec offset = frame_origin - gp_Vec(position.Location().XYZ());
    if (std::fabs(surface_normal.Dot(offset)) > 1e-6 * (1 + std::fabs(gp_Vec(normal).Dot(frame_origin)))) continue;
    for (size_t p = 0; p + 2 < probes.size(); p += 3)
      if (nearest_distance(face, point_at(probes, p)) < 1e-6) return face;
  }
  return TopoDS_Shape();
}

}  // namespace

std::unique_ptr<ShapeList> new_shape_list() { return std::make_unique<ShapeList>(); }

void shape_list_add(ShapeList &list, const Shape &shape) { list.shapes.push_back(shape.shape); }

namespace {

template <typename Maker, typename AddEdge>
std::unique_ptr<Shape> round_edges(const TopoDS_Shape &shape, rust::Slice<const uint32_t> indices, Maker &maker, AddEdge add) {
  const TopTools_IndexedMapOfShape edges = unique_sub_shapes(shape, TopAbs_EDGE);
  for (uint32_t index : indices)
    if (static_cast<int>(index) >= edges.Extent()) return nullptr;
  std::vector<TopoDS_Shape> selected;
  if (indices.empty())
    for (int i = 1; i <= edges.Extent(); ++i) selected.push_back(edges(i));
  else
    for (uint32_t index : indices) selected.push_back(edges(static_cast<int>(index) + 1));
  if (selected.empty()) return nullptr;
  for (const TopoDS_Shape &current : selected) {
    try {
      add(maker, TopoDS::Edge(current));
    } catch (const Standard_Failure &) {
      // degenerate or seam edge: skipped
    }
  }
  maker.Build();
  return maker.IsDone() ? wrap(valid_or_null(maker.Shape())) : nullptr;
}

}  // namespace

std::unique_ptr<Shape> fillet_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double radius, double radius_end) {
  BRepFilletAPI_MakeFillet maker(shape.shape, ChFi3d_Rational);
  const bool varying = !std::isnan(radius_end);
  return round_edges(shape.shape, edges, maker, [&](BRepFilletAPI_MakeFillet &target, const TopoDS_Edge &edge) {
    if (varying)
      target.Add(radius, radius_end, edge);
    else
      target.Add(radius, edge);
  });
}

std::unique_ptr<Shape> chamfer_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double distance) {
  BRepFilletAPI_MakeChamfer maker(shape.shape);
  return round_edges(shape.shape, edges, maker,
                     [&](BRepFilletAPI_MakeChamfer &target, const TopoDS_Edge &edge) { target.Add(distance, edge); });
}

std::unique_ptr<Shape> blend_union(const ShapeList &list, double radius) {
  if (list.shapes.size() < 2 || !(radius > 0)) return nullptr;
  TopTools_ListOfShape arguments;
  arguments.Append(list.shapes[0]);
  TopTools_ListOfShape tools;
  for (size_t i = 1; i < list.shapes.size(); ++i) tools.Append(list.shapes[i]);
  BRepAlgoAPI_Fuse fuse;
  fuse.SetArguments(arguments);
  fuse.SetTools(tools);
  fuse.Build();
  if (!fuse.IsDone()) return nullptr;
  const TopoDS_Shape fused = fuse.Shape();
  const TopTools_IndexedMapOfShape boundary = unique_sub_shapes(fused, TopAbs_EDGE);
  std::vector<TopoDS_Edge> joints;
  for (TopTools_ListIteratorOfListOfShape it(fuse.SectionEdges()); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Value());
    if (BRep_Tool::Degenerated(edge)) continue;
    if (boundary.Contains(edge)) joints.push_back(edge);
  }
  if (joints.empty()) return wrap(fused);
  BRepFilletAPI_MakeFillet maker(fused, ChFi3d_Rational);
  for (const TopoDS_Edge &edge : joints) maker.Add(radius, edge);
  maker.Build();
  return maker.IsDone() ? wrap(maker.Shape()) : nullptr;
}

std::unique_ptr<Shape> shell_hollow(const Shape &shape, double thickness) {
  if (!(thickness > 0)) return nullptr;
  BRepOffsetAPI_MakeOffsetShape offset;
  offset.PerformByJoin(shape.shape, -thickness, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc, Standard_False);
  if (!offset.IsDone()) return nullptr;
  BRepAlgoAPI_Cut cut(shape.shape, closed_cavity(offset.Shape()));
  cut.Build();
  return cut.IsDone() ? wrap(cut.Shape()) : nullptr;
}

std::unique_ptr<Shape> shell_open(const Shape &shape, double thickness, rust::Slice<const double> open_near) {
  if (!(thickness > 0) || open_near.size() < 3 || open_near.size() % 3 != 0) return nullptr;
  const TopTools_IndexedMapOfShape faces = unique_sub_shapes(shape.shape, TopAbs_FACE);
  TopTools_IndexedMapOfShape picked;
  for (size_t p = 0; p < open_near.size(); p += 3) {
    const gp_Pnt point = point_at(open_near, p);
    int best = 0;
    double best_distance = 0;
    for (int i = 1; i <= faces.Extent(); ++i) {
      const double distance = nearest_distance(faces(i), point);
      if (best == 0 || distance < best_distance) {
        best = i;
        best_distance = distance;
      }
    }
    if (best == 0 || !std::isfinite(best_distance)) return nullptr;
    picked.Add(faces(best));
  }
  TopTools_ListOfShape closing;
  for (int i = 1; i <= picked.Extent(); ++i) closing.Append(picked(i));
  BRepOffsetAPI_MakeThickSolid maker;
  maker.MakeThickSolidByJoin(shape.shape, closing, -thickness, 1e-3, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc,
                             Standard_False);
  return maker.IsDone() ? wrap(valid_or_null(maker.Shape())) : nullptr;
}

std::unique_ptr<Shape> chain_face(rust::Slice<const double> chain) {
  const TopoDS_Wire wire = chain_wire(chain);
  if (wire.IsNull()) return nullptr;
  BRepBuilderAPI_MakeFace face(wire, Standard_True);
  return face.IsDone() ? wrap(face.Face()) : nullptr;
}

bool chain_wire_ok(rust::Slice<const double> chain) { return !chain_wire(chain).IsNull(); }

std::unique_ptr<Shape> circle_section(rust::Slice<const double> center, rust::Slice<const double> normal, double radius,
                                      double inner_radius) {
  const gp_Pnt origin = point_at(center, 0);
  const gp_Dir direction = direction_of(normal);
  BRepBuilderAPI_MakeFace face(circle_wire(origin, direction, radius), Standard_True);
  if (!std::isnan(inner_radius)) {
    TopoDS_Wire hole = circle_wire(origin, direction, inner_radius);
    hole.Reverse();
    face.Add(hole);
  }
  return face.IsDone() ? wrap(face.Face()) : nullptr;
}

std::unique_ptr<Shape> prism_of_face(const Shape &face, rust::Slice<const double> direction) {
  if (direction.size() != 3) throw std::invalid_argument("prism: need a 3D direction");
  BRepPrimAPI_MakePrism maker(face.shape, gp_Vec(direction[0], direction[1], direction[2]), Standard_False, Standard_True);
  return wrap(maker.Shape());
}

std::unique_ptr<Shape> revolution_of_face(const Shape &face, rust::Slice<const double> axis, double angle) {
  BRepPrimAPI_MakeRevol maker(face.shape, gp_Ax1(gp_Pnt(0, 0, 0), direction_of(axis)), angle, Standard_False);
  return wrap(maker.Shape());
}

std::unique_ptr<Shape> skinned_solid(rust::Slice<const double> chains, rust::Slice<const uint32_t> lengths, bool ruled) {
  BRepOffsetAPI_ThruSections maker(Standard_True, ruled, 1e-6);
  maker.CheckCompatibility(Standard_False);
  size_t offset = 0;
  for (uint32_t length : lengths) {
    if (offset + length > chains.size()) throw std::invalid_argument("loft: chain lengths overrun");
    const TopoDS_Wire wire = chain_wire(rust::Slice<const double>(chains.data() + offset, length));
    if (wire.IsNull()) return nullptr;
    maker.AddWire(wire);
    offset += length;
  }
  maker.Build();
  return maker.IsDone() ? wrap(maker.Shape()) : nullptr;
}

std::unique_ptr<Shape> pipe_solid(rust::Slice<const double> spine, const Shape &section) {
  const TopoDS_Wire wire = chain_wire(spine);
  if (wire.IsNull()) return nullptr;
  BRepOffsetAPI_MakePipe pipe(wire, section.shape, GeomFill_IsCorrectedFrenet, Standard_False);
  pipe.Build();
  return pipe.IsDone() ? wrap(pipe.Shape()) : nullptr;
}

std::unique_ptr<Shape> bspline_patch_solid(rust::Slice<const double> poles, double tolerance) {
  if (poles.empty() || poles.size() % 48 != 0) return nullptr;
  try {
    std::vector<TopoDS_Shape> faces;
    for (size_t offset = 0; offset < poles.size(); offset += 48) {
      const TopoDS_Shape face = patch_face(poles, offset);
      if (face.IsNull()) return nullptr;
      faces.push_back(face);
    }
    return wrap(sewn_solid(faces, tolerance));
  } catch (const Standard_Failure &) {
    // occtPatches.ts: an OCC exception never refuses the solid, the caller falls back to the subdivided triangles.
    return nullptr;
  }
}

std::unique_ptr<Shape> feature_revol_cut(const Shape &source, rust::Slice<const double> profile, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal) {
  const TopoDS_Shape face = polygon_face(profile);
  if (face.IsNull()) return nullptr;
  BRepFeat_MakeRevol maker;
  maker.Init(source.shape, face, TopoDS_Face(), gp_Ax1(point_at(origin, 0), direction_of(normal)), 0, Standard_True);
  maker.Perform(2 * M_PI);
  return maker.IsDone() ? wrap(maker.Shape()) : nullptr;
}

std::unique_ptr<Shape> feature_prism_cut(const Shape &source, rust::Slice<const double> chain, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal, rust::Slice<const double> probes, double length) {
  const gp_Dir frame_normal = direction_of(normal);
  const TopoDS_Shape sketch = supporting_face(source.shape, point_at(origin, 0), frame_normal, probes);
  const std::unique_ptr<Shape> profile = chain_face(chain);
  if (sketch.IsNull() || profile == nullptr) return nullptr;
  BRepFeat_MakePrism maker;
  maker.Init(source.shape, profile->shape, TopoDS::Face(sketch), frame_normal.Reversed(), 0, Standard_True);
  maker.Perform(length);
  return maker.IsDone() ? wrap(maker.Shape()) : nullptr;
}

bool is_valid_shape(const Shape &shape) {
  BRepCheck_Analyzer check(shape.shape, Standard_True);
  return check.IsValid();
}

std::unique_ptr<Shape> unified_shape(const Shape &shape) {
  try {
    ShapeUpgrade_UnifySameDomain unifier(shape.shape, Standard_True, Standard_True, Standard_False);
    unifier.AllowInternalEdges(Standard_False);
    unifier.Build();
    return wrap(unifier.Shape());
  } catch (const Standard_Failure &) {
    return wrap(shape.shape);
  }
}

}  // namespace llull

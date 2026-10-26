// OCCT side of the native kernel's feature operations. Every builder mirrors packages/kernel-occt (opencascade.js, OCCT 7.4):
// occtKernel.ts (roundEdges, blendedUnion, hollow, openShell), occtCurves.ts (segment edges, wires, faces, ThruSections, MakePipe),
// occtPatches.ts (Coons-filled B-spline patches with their poles set, sewn) and occtFeatures.ts (BRepFeat makers).
#include "llull-kernel-occt/cpp/features.hxx"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

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
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFeat_MakePrism.hxx>
#include <BRepFeat_MakeRevol.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepBuilderAPI_TransitionMode.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <Law_Interpol.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GC_MakeArcOfEllipse.hxx>
#include <gp_Ax2.hxx>
#include <gp_Elips.hxx>
#include <gp_Vec.hxx>
#include <GeomFill_BSplineCurves.hxx>
#include <Geom2d_Line.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <gp_Pnt2d.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir2d.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>

#include "llull-kernel-occt/cpp/blends.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
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

// Exact quarter of an ellipse from [start, centre, end] (conjugate semi-diameters u = start - centre, v = end - centre; P(t) = C + cos(pi t / 2) u +
// sin(pi t / 2) v, curves.ts 'ellipse'): the ellipse on its principal axes, trimmed counter-clockwise about u x v from start to end. Null edge when
// u, v are collinear or OCC rejects it.
TopoDS_Edge ellipse_edge(rust::Slice<const double> chain, size_t offset) {
  const gp_Pnt start = point_at(chain, offset);
  const gp_Pnt center = point_at(chain, offset + 3);
  const gp_Pnt end = point_at(chain, offset + 6);
  const gp_Vec u(center, start);
  const gp_Vec v(center, end);
  const gp_Vec normal = u.Crossed(v);
  if (normal.Magnitude() <= 1e-9 * u.Magnitude() * v.Magnitude()) return TopoDS_Edge();
  const double theta = 0.5 * std::atan2(2.0 * u.Dot(v), u.Dot(u) - v.Dot(v));
  const gp_Vec p = u * std::cos(theta) + v * std::sin(theta);
  const gp_Vec q = u * -std::sin(theta) + v * std::cos(theta);
  const bool p_major = p.Magnitude() >= q.Magnitude();
  const gp_Vec major = p_major ? p : q;
  const double major_radius = p_major ? p.Magnitude() : q.Magnitude();
  const double minor_radius = p_major ? q.Magnitude() : p.Magnitude();
  const gp_Elips ellipse(gp_Ax2(center, gp_Dir(normal), gp_Dir(major)), major_radius, minor_radius);
  GC_MakeArcOfEllipse arc(ellipse, start, end, Standard_True);
  if (!arc.IsDone()) return TopoDS_Edge();
  const Handle(Geom_TrimmedCurve) trimmed = arc.Value();
  const Handle(Geom_Curve) curve(trimmed);
  BRepBuilderAPI_MakeEdge maker(curve);
  return maker.IsDone() ? maker.Edge() : TopoDS_Edge();
}

// occtCurves.ts segmentEdge: line / circular arc through three points / cubic Bezier / ellipse quarter; null edge when OCC rejects it.
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
  if (type == 3) return ellipse_edge(chain, offset);
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
    if (type < 0 || type > 3) throw std::invalid_argument("chain: unknown segment type");
    const TopoDS_Edge edge = segment_edge(type, chain, offset + 1);
    if (edge.IsNull()) return TopoDS_Wire();
    maker.Add(edge);
    offset += 1 + 3 * static_cast<size_t>(type == 3 ? 3 : type + 2);
  }
  return maker.IsDone() ? maker.Wire() : TopoDS_Wire();
}

// One exact NURBS section as a wire (see features.hxx `skinned_solid_bsplines` for the layout): a single Geom_BSplineCurve edge, plus the straight
// closing edge when asked. Null wire when OCC rejects the curve or an edge; std::invalid_argument when the data are inconsistent.
TopoDS_Wire bspline_wire(rust::Slice<const double> data) {
  if (data.size() < 5) throw std::invalid_argument("bspline section: header too short");
  const int degree = static_cast<int>(data[0]);
  const int pole_count = static_cast<int>(data[1]);
  const int knot_count = static_cast<int>(data[2]);
  const bool rational = data[3] != 0.0;
  const bool closing = data[4] != 0.0;
  if (degree < 1 || pole_count < degree + 1 || knot_count < 2) throw std::invalid_argument("bspline section: bad counts");
  const size_t poles_size = 3 * static_cast<size_t>(pole_count);
  const size_t weights_size = rational ? static_cast<size_t>(pole_count) : 0;
  if (data.size() != 5 + poles_size + weights_size + 2 * static_cast<size_t>(knot_count))
    throw std::invalid_argument("bspline section: length mismatch");
  size_t offset = 5;
  TColgp_Array1OfPnt poles(1, pole_count);
  for (int i = 0; i < pole_count; ++i) poles.SetValue(i + 1, point_at(data, offset + 3 * static_cast<size_t>(i)));
  offset += poles_size;
  TColStd_Array1OfReal weights(1, pole_count);
  for (int i = 0; i < pole_count; ++i) weights.SetValue(i + 1, rational ? data[offset + static_cast<size_t>(i)] : 1.0);
  offset += weights_size;
  TColStd_Array1OfReal knots(1, knot_count);
  for (int i = 0; i < knot_count; ++i) knots.SetValue(i + 1, data[offset + static_cast<size_t>(i)]);
  offset += static_cast<size_t>(knot_count);
  TColStd_Array1OfInteger multiplicities(1, knot_count);
  int total = 0;
  for (int i = 0; i < knot_count; ++i) {
    const int multiplicity = static_cast<int>(data[offset + static_cast<size_t>(i)]);
    multiplicities.SetValue(i + 1, multiplicity);
    total += multiplicity;
  }
  if (total != pole_count + degree + 1) throw std::invalid_argument("bspline section: multiplicities do not fit the poles");
  const Handle(Geom_BSplineCurve) curve =
      rational ? new Geom_BSplineCurve(poles, weights, knots, multiplicities, degree) : new Geom_BSplineCurve(poles, knots, multiplicities, degree);
  // One edge per knot span (each the exact segment of the curve). As ONE multi-span edge the solid was exact but OCC's Gauss rule (mass
  // properties, analyze) integrated its faces span-blind: the NACA 0012 half wing of VC-SRF-11 gave 0.846 m^3 instead of 0.959117, a degree-1
  // square loft 6.963 instead of 8 (measured with OCCT 7.9.2; the tessellations gave the exact volumes).
  BRepBuilderAPI_MakeWire maker;
  for (int k = 1; k < curve->NbKnots(); ++k) {
    const Handle(Geom_BSplineCurve) span = Handle(Geom_BSplineCurve)::DownCast(curve->Copy());
    span->Segment(curve->Knot(k), curve->Knot(k + 1));
    BRepBuilderAPI_MakeEdge edge(span);
    if (!edge.IsDone()) return TopoDS_Wire();
    maker.Add(edge.Edge());
    if (!maker.IsDone()) return TopoDS_Wire();
  }
  if (closing) {
    const gp_Pnt first = curve->StartPoint();
    const gp_Pnt last = curve->EndPoint();
    if (first.Distance(last) > 1e-9) {
      BRepBuilderAPI_MakeEdge closer(last, first);
      if (!closer.IsDone()) return TopoDS_Wire();
      maker.Add(closer.Edge());
    }
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

// Names of a BRepFeat cut: the source's faces through the maker's history; the tool's faces, generated from the edges of the
// profile face, are "<tag>(e(profile)#k)", so two holes of one feature, or two features, never share a name.
// A feature of a deformed body keeps its adaptive mass rule (facade.cxx `volume_props`).
std::unique_ptr<Shape> keep_mass_rule(std::unique_ptr<Shape> out, const Shape &source) {
  if (out != nullptr && source.refined_mass) out->refined_mass = true;
  return out;
}

template <class Maker>
std::unique_ptr<Shape> feature_named(Maker &maker, const Shape &source, const TopoDS_Shape &profile, const std::string &tag) {
  const TopoDS_Shape result = maker.Shape();
  const std::vector<naming::Named> inputs{naming::named(source), naming::Named{profile, {"profile"}}};
  return keep_mass_rule(naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), tag)), source);
}

}  // namespace

std::unique_ptr<ShapeList> new_shape_list() { return std::make_unique<ShapeList>(); }

void shape_list_add(ShapeList &list, const Shape &shape) {
  list.shapes.push_back(shape.shape);
  list.names.push_back(naming::face_names(shape));
}

namespace {

template <typename Maker, typename AddEdge>
std::unique_ptr<Shape> round_edges(const Shape &source, rust::Slice<const uint32_t> indices, Maker &maker, AddEdge add, const char *role) {
  const TopoDS_Shape &shape = source.shape;
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
  if (!maker.IsDone()) return nullptr;
  const TopoDS_Shape result = valid_or_null(maker.Shape());
  if (result.IsNull()) return nullptr;
  const std::vector<naming::Named> inputs{naming::named(source)};
  return keep_mass_rule(naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), role)), source);
}

}  // namespace

std::unique_ptr<Shape> fillet_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double radius, double radius_end) {
  BRepFilletAPI_MakeFillet maker(shape.shape, ChFi3d_Rational);
  const bool varying = !std::isnan(radius_end);
  return round_edges(
      shape, edges, maker,
      [&](BRepFilletAPI_MakeFillet &target, const TopoDS_Edge &edge) {
        if (varying)
          target.Add(radius, radius_end, edge);
        else
          target.Add(radius, edge);
      },
      "blend");
}

std::unique_ptr<Shape> fillet_laws(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws) {
  const TopTools_IndexedMapOfShape unique = unique_sub_shapes(shape.shape, TopAbs_EDGE);
  if (edges.empty()) return nullptr;
  LawFillet maker(shape.shape);
  if (!add_fillet_laws(maker, unique, edges, laws)) return nullptr;
  maker.Build();
  if (!maker.IsDone()) return nullptr;
  const TopoDS_Shape result = valid_or_null(maker.Shape());
  if (result.IsNull()) return nullptr;
  const std::vector<naming::Named> inputs{naming::named(shape)};
  std::unique_ptr<Shape> out =
      keep_mass_rule(naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), "blend")), shape);
  if (out != nullptr && has_straight_kink(laws)) out->refined_mass = true;
  return out;
}

std::unique_ptr<Shape> chamfer_edges(const Shape &shape, rust::Slice<const uint32_t> edges, double distance) {
  BRepFilletAPI_MakeChamfer maker(shape.shape);
  return round_edges(
      shape, edges, maker, [&](BRepFilletAPI_MakeChamfer &target, const TopoDS_Edge &edge) { target.Add(distance, edge); }, "chamfer");
}

std::unique_ptr<Shape> chamfer_sided(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const uint32_t> faces, double first,
                                     double second, bool angle) {
  const TopTools_IndexedMapOfShape unique_edges = unique_sub_shapes(shape.shape, TopAbs_EDGE);
  const TopTools_IndexedMapOfShape unique_faces = unique_sub_shapes(shape.shape, TopAbs_FACE);
  if (edges.empty() || edges.size() != faces.size()) return nullptr;
  BRepFilletAPI_MakeChamfer maker(shape.shape);
  TopTools_IndexedDataMapOfShapeListOfShape owners;
  TopExp::MapShapesAndAncestors(shape.shape, TopAbs_EDGE, TopAbs_FACE, owners);
  for (size_t k = 0; k < edges.size(); ++k) {
    if (static_cast<int>(edges[k]) >= unique_edges.Extent() || static_cast<int>(faces[k]) >= unique_faces.Extent()) return nullptr;
    const TopoDS_Edge edge = TopoDS::Edge(unique_edges(static_cast<int>(edges[k]) + 1));
    const TopoDS_Face face = TopoDS::Face(unique_faces(static_cast<int>(faces[k]) + 1));
    if (!owners.Contains(edge)) return nullptr;
    bool adjacent = false;
    for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(edge)); it.More(); it.Next()) adjacent = adjacent || it.Value().IsSame(face);
    if (!adjacent) return nullptr;  // the first leg is measured on a face of the edge
    try {
      if (angle)
        maker.AddDA(first, second, edge, face);
      else
        maker.Add(first, second, edge, face);
    } catch (const Standard_Failure &) {
      return nullptr;  // an edge or face the chamfer cannot take (seam, degenerate, not adjacent): refuse, never skip it
    }
  }
  try {
    maker.Build();
  } catch (const Standard_Failure &) {
    return nullptr;  // no edge the chamfer can take
  }
  if (!maker.IsDone()) return nullptr;
  const TopoDS_Shape result = valid_or_null(maker.Shape());
  if (result.IsNull()) return nullptr;
  const std::vector<naming::Named> inputs{naming::named(shape)};
  return keep_mass_rule(naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), "chamfer")), shape);
}

// A joint pick may lie at most this many of its own radii away from the joint it names: a pick farther than that is a mistake, not a choice.
constexpr double kJointReach = 10.0;

// The joint edge (section edge of the fuse) nearest to `point` and its distance, or -1 when there is none.
static int nearest_joint(const std::vector<TopoDS_Edge> &joints, const gp_Pnt &point, double &distance_out) {
  const TopoDS_Vertex probe = BRepBuilderAPI_MakeVertex(point);
  int best = -1;
  double best_distance = std::numeric_limits<double>::infinity();
  for (size_t k = 0; k < joints.size(); ++k) {
    BRepExtrema_DistShapeShape distance(probe, joints[k]);
    if (!distance.IsDone()) continue;
    if (distance.Value() < best_distance) {
      best_distance = distance.Value();
      best = static_cast<int>(k);
    }
  }
  distance_out = best_distance;
  return best;
}

// `picks` = x, y, z, radius per picked joint: the joint (and its tangent chain) nearest to the point takes that radius, every other joint `radius`.
// `notes` receives the JSON the shape carries: per pick the distance to its joint and its radius, per contour its radius and the names of its joint edges.
// A reason that starts with "[BLD_JOINT_PARAMS] joints[i]." is about pick i.
static std::unique_ptr<Shape> build_blend_union(const ShapeList &list, double radius, rust::Slice<const double> picks, std::string &notes,
                                                std::string &why) {
  if (list.shapes.size() < 2 || !(radius > 0)) {
    why = "needs two or more solids and a radius > 0";
    return nullptr;
  }
  if (picks.size() % 4 != 0) {
    why = "[BLD_JOINT_PARAMS] joints: the joint radii are malformed";
    return nullptr;
  }
  TopTools_ListOfShape arguments;
  arguments.Append(list.shapes[0]);
  TopTools_ListOfShape tools;
  for (size_t i = 1; i < list.shapes.size(); ++i) tools.Append(list.shapes[i]);
  BRepAlgoAPI_Fuse fuse;
  fuse.SetArguments(arguments);
  fuse.SetTools(tools);
  fuse.Build();
  if (!fuse.IsDone()) {
    why = "the union of the solids failed";
    return nullptr;
  }
  const TopoDS_Shape fused = fuse.Shape();
  std::vector<naming::Named> inputs;
  for (size_t i = 0; i < list.shapes.size(); ++i) inputs.push_back(naming::Named{list.shapes[i], list.names[i]});
  const std::vector<std::string> fused_names = naming::inherit(fused, inputs, fuse.History(), "boolean");
  const TopTools_IndexedMapOfShape boundary = unique_sub_shapes(fused, TopAbs_EDGE);
  const std::vector<std::string> edge_names = naming::edge_names(fused, fused_names);
  std::vector<TopoDS_Edge> joints;
  for (TopTools_ListIteratorOfListOfShape it(fuse.SectionEdges()); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Value());
    if (BRep_Tool::Degenerated(edge)) continue;
    if (boundary.Contains(edge)) joints.push_back(edge);
  }
  notes = "{\"builder\":\"union\",\"picks\":[],\"contours\":[]}";
  if (joints.empty()) {
    if (picks.size() > 0) {
      why = "[BLD_JOINT_PARAMS] joints: the solids share no joint to give a radius to; give joints only for solids that overlap or touch along a joint";
      return nullptr;
    }
    return naming::wrap_named(fused, fused_names);
  }
  BRepFilletAPI_MakeFillet maker(fused, ChFi3d_Rational);
  std::map<int, double> contour_radius;
  std::map<int, size_t> contour_pick;  // the first pick that named the contour
  std::ostringstream pick_notes;
  pick_notes.precision(17);
  for (size_t at = 0; at + 4 <= picks.size(); at += 4) {
    const std::string label = "joints[" + std::to_string(at / 4) + "]";
    const double r = picks[at + 3];
    if (!(r > 0) || !std::isfinite(r)) {
      why = "[BLD_JOINT_PARAMS] " + label + ".radius: a joint radius must be > 0";
      return nullptr;
    }
    double distance = 0;
    const int joint = nearest_joint(joints, gp_Pnt(picks[at], picks[at + 1], picks[at + 2]), distance);
    if (joint < 0) {
      why = "[BLD_JOINT_PARAMS] " + label + ".near: the pick could not be measured against the joints";
      return nullptr;
    }
    if (distance > kJointReach * r) {
      why = "[BLD_JOINT_PARAMS] " + label + ".near: the point is " + std::to_string(distance) + " from the nearest joint, more than 10 x its radius (" +
            std::to_string(kJointReach * r) + "); move it onto the joint you mean";
      return nullptr;
    }
    pick_notes << (at == 0 ? "" : ",") << "{\"distance\":" << distance << ",\"radius\":" << r << "}";
    const TopoDS_Edge &edge = joints[static_cast<size_t>(joint)];
    const int known = maker.Contour(edge);
    if (known > 0) {
      if (std::fabs(contour_radius[known] - r) > 1e-12 * std::max(r, contour_radius[known])) {
        why = "[BLD_JOINT_PARAMS] " + label + ".radius: " + std::to_string(r) + " and " + std::to_string(contour_radius[known]) +
              " go to joints of one tangent chain, which is rounded with one radius: give one radius per chain";
        return nullptr;
      }
      continue;
    }
    maker.Add(r, edge);
    contour_radius[maker.Contour(edge)] = r;
    contour_pick[maker.Contour(edge)] = at / 4;
  }
  for (const TopoDS_Edge &edge : joints) {
    if (picks.size() > 0 && maker.Contour(edge) > 0) continue;
    maker.Add(radius, edge);
  }
  maker.Build();
  if (!maker.IsDone()) {
    why = "the kernel could not fillet the joints with these radii";
    return nullptr;
  }
  std::ostringstream contour_notes;
  contour_notes.precision(17);
  std::map<int, std::pair<double, std::vector<std::string>>> by_contour;
  for (const TopoDS_Edge &edge : joints) {
    const int contour = maker.Contour(edge);
    auto &entry = by_contour[contour];
    entry.first = contour_radius.count(contour) > 0 ? contour_radius[contour] : radius;
    entry.second.push_back(edge_names[static_cast<size_t>(boundary.FindIndex(edge) - 1)]);
  }
  bool first_contour = true;
  for (const auto &[contour, entry] : by_contour) {
    const std::string source = contour_pick.count(contour) > 0 ? "joints[" + std::to_string(contour_pick[contour]) + "]" : "default";
    contour_notes << (first_contour ? "" : ",") << "{\"radius\":" << entry.first << ",\"source\":\"" << source << "\",\"edges\":[";
    first_contour = false;
    for (size_t k = 0; k < entry.second.size(); ++k) {
      contour_notes << (k == 0 ? "" : ",") << '"';
      for (const char c : entry.second[k]) {
        if (c == '"' || c == '\\') contour_notes << '\\';
        contour_notes << c;
      }
      contour_notes << '"';
    }
    contour_notes << "]}";
  }
  notes = "{\"builder\":\"union\",\"picks\":[" + pick_notes.str() + "],\"contours\":[" + contour_notes.str() + "]}";
  const std::vector<naming::Named> joined{naming::Named{fused, fused_names}};
  const TopoDS_Shape result = maker.Shape();
  return naming::wrap_named(result, naming::inherit(result, joined, naming::history_of(joined, maker), "blend"));
}

std::unique_ptr<Shape> blend_union(const ShapeList &list, double radius, rust::Slice<const double> joints) {
  std::string why, notes;
  try {
    std::unique_ptr<Shape> built = build_blend_union(list, radius, joints, notes, why);
    if (built) built->notes = notes;
    return built;
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String blend_union_reason(const ShapeList &list, double radius, rust::Slice<const double> joints) {
  std::string why, notes;
  std::unique_ptr<Shape> built;
  try {
    built = build_blend_union(list, radius, joints, notes, why);
  } catch (const Standard_Failure &error) {
    why = std::string("OCCT failed: ") + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string("the blend failed") : why));
}

std::unique_ptr<Shape> shell_hollow(const Shape &shape, double thickness) {
  if (!(thickness > 0)) return nullptr;
  BRepOffsetAPI_MakeOffsetShape offset;
  offset.PerformByJoin(shape.shape, -thickness, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc, Standard_False);
  if (!offset.IsDone()) return nullptr;
  const std::vector<naming::Named> source{naming::named(shape)};
  const TopoDS_Shape skin = offset.Shape();
  const naming::Named offset_skin{skin, naming::inherit(skin, source, naming::history_of(source, offset), "inner", naming::Images::Offset)};
  const TopoDS_Shape cavity = closed_cavity(skin);
  // ShapeFix_Solid wraps the same faces: the cavity keeps the skin's names face for face.
  const naming::Named cavity_named{cavity, naming::inherit(cavity, {offset_skin}, Handle(BRepTools_History)(), "inner")};
  BRepAlgoAPI_Cut cut(shape.shape, cavity);
  cut.Build();
  if (!cut.IsDone()) return nullptr;
  const TopoDS_Shape result = cut.Shape();
  return keep_mass_rule(naming::wrap_named(result, naming::inherit(result, {source[0], cavity_named}, cut.History(), "inner")), shape);
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
  if (!maker.IsDone()) return nullptr;
  const TopoDS_Shape result = valid_or_null(maker.Shape());
  if (result.IsNull()) return nullptr;
  const std::vector<naming::Named> source{naming::named(shape)};
  return keep_mass_rule(
      naming::wrap_named(result, naming::inherit(result, source, naming::history_of(source, maker), "inner", naming::Images::Offset)), shape);
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
  const TopoDS_Shape result = maker.Shape();
  return naming::wrap_named(result, naming::swept_roles(result, face.shape, maker, "side"));
}

std::unique_ptr<Shape> revolution_of_face(const Shape &face, rust::Slice<const double> axis, double angle) {
  BRepPrimAPI_MakeRevol maker(face.shape, gp_Ax1(gp_Pnt(0, 0, 0), direction_of(axis)), angle, Standard_False);
  const TopoDS_Shape result = maker.Shape();
  return naming::wrap_named(result, naming::swept_roles(result, face.shape, maker, "section"));
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

std::unique_ptr<Shape> skinned_solid_bsplines(rust::Slice<const double> curves, rust::Slice<const uint32_t> lengths, bool ruled) {
  BRepOffsetAPI_ThruSections maker(Standard_True, ruled, 1e-6);
  maker.CheckCompatibility(Standard_False);
  size_t offset = 0;
  for (uint32_t length : lengths) {
    if (offset + length > curves.size()) throw std::invalid_argument("loft: section lengths overrun");
    const TopoDS_Wire wire = bspline_wire(rust::Slice<const double>(curves.data() + offset, length));
    if (wire.IsNull()) return nullptr;
    maker.AddWire(wire);
    offset += length;
  }
  maker.Build();
  return maker.IsDone() ? wrap(maker.Shape()) : nullptr;
}

namespace {

// MakePipe of one section shape (null when OCC fails).
TopoDS_Shape pipe_of(const TopoDS_Wire &spine, const TopoDS_Shape &section) {
  BRepOffsetAPI_MakePipe pipe(spine, section, GeomFill_IsCorrectedFrenet, Standard_False);
  pipe.Build();
  return pipe.IsDone() ? pipe.Shape() : TopoDS_Shape();
}

// A holed section round a CLOSED spine: MakePipe puts the outer tube and the bore tube in ONE shell (BRepCheck_NotConnected, LIM-1), so
// the ring is the solid of the outer boundary minus the solid of each bore (no caps, disjoint boundaries: a plain cut).
TopoDS_Shape closed_holed_pipe(const TopoDS_Wire &spine, const TopoDS_Face &section) {
  const TopoDS_Wire outer = BRepTools::OuterWire(section);
  const Handle(Geom_Surface) plane = BRep_Tool::Surface(section);
  TopoDS_Shape result = pipe_of(spine, BRepBuilderAPI_MakeFace(plane, outer, Standard_True).Face());
  if (result.IsNull()) return result;
  for (TopExp_Explorer it(section, TopAbs_WIRE); it.More(); it.Next()) {
    if (it.Current().IsSame(outer)) continue;
    TopoDS_Wire bore = TopoDS::Wire(it.Current());
    bore.Reverse();
    const TopoDS_Shape core = pipe_of(spine, BRepBuilderAPI_MakeFace(plane, bore, Standard_True).Face());
    if (core.IsNull()) return core;
    BRepAlgoAPI_Cut cut(result, core);
    cut.Build();
    if (!cut.IsDone()) return TopoDS_Shape();
    result = cut.Shape();
  }
  return valid_or_null(result);
}

}  // namespace

std::unique_ptr<Shape> pipe_solid(rust::Slice<const double> spine, const Shape &section) {
  const TopoDS_Wire wire = chain_wire(spine);
  if (wire.IsNull()) return nullptr;
  const bool holed = section.shape.ShapeType() == TopAbs_FACE && unique_sub_shapes(section.shape, TopAbs_WIRE).Extent() > 1;
  const TopoDS_Shape result =
      holed && BRep_Tool::IsClosed(wire) ? closed_holed_pipe(wire, TopoDS::Face(section.shape)) : pipe_of(wire, section.shape);
  return result.IsNull() ? nullptr : wrap(result);
}

namespace {

// The exact helix as one edge: a straight line in the (angle, height / slant) parameter plane of a cylinder or cone (CadQuery makeHelix). Layout of
// `helix`: origin xyz, axis xyz, x direction xyz, radius, end radius, turns, pitch, left-hand flag (1), start angle. Null wire when OCC refuses.
TopoDS_Wire helix_wire(rust::Slice<const double> helix) {
  if (helix.size() != 15) throw std::invalid_argument("helix: expected 15 numbers");
  const gp_Pnt origin(helix[0], helix[1], helix[2]);
  const gp_Ax3 frame(origin, gp_Dir(helix[3], helix[4], helix[5]), gp_Dir(helix[6], helix[7], helix[8]));
  const double radius = helix[9];
  const double end_radius = helix[10];
  const double turns = helix[11];
  const double pitch = helix[12];
  const bool left = helix[13] != 0.0;
  const double start = helix[14];
  if (!(radius > 0 && end_radius > 0 && turns > 0 && pitch > 0)) throw std::invalid_argument("helix: radii, turns and pitch must be > 0");
  const double total = 2.0 * M_PI * turns;
  const double rise = pitch / (2.0 * M_PI);
  Handle(Geom_Surface) surface;
  double advance = rise;
  if (std::abs(end_radius - radius) <= 1e-12 * radius) {
    surface = new Geom_CylindricalSurface(frame, radius);
  } else {
    const double angle = std::atan((end_radius - radius) / (pitch * turns));
    surface = new Geom_ConicalSurface(frame, angle, radius);
    advance = rise / std::cos(angle);
  }
  const double direction = left ? -1.0 : 1.0;
  Handle(Geom2d_Line) line = new Geom2d_Line(gp_Pnt2d(start, 0.0), gp_Dir2d(direction, advance));
  const double length = total * std::sqrt(1.0 + advance * advance);
  BRepBuilderAPI_MakeEdge edge(line, surface, 0.0, length);
  if (!edge.IsDone()) return TopoDS_Wire();
  TopoDS_Edge spine = edge.Edge();
  BRepLib::BuildCurves3d(spine, 1e-10, GeomAbs_C1, 14, std::max(60, static_cast<int>(std::ceil(turns * 32.0))));
  BRepBuilderAPI_MakeWire wire(spine);
  return wire.IsDone() ? wire.Wire() : TopoDS_Wire();
}

}  // namespace

std::unique_ptr<Shape> helix_pipe_solid(rust::Slice<const double> helix, const Shape &section) {
  const TopoDS_Wire wire = helix_wire(helix);
  if (wire.IsNull()) return nullptr;
  const TopoDS_Shape result = pipe_of(wire, section.shape);
  return result.IsNull() ? nullptr : wrap(result);
}

// SWG M8 fast path: BRepOffsetAPI_MakePipeShell of the section's outer wire along the spine. `mode`: 0 corrected Frenet, 1 Frenet, 2 fixed trihedron
// (section planes parallel; `direction` is the plane normal), 3 binormal (`direction`), 4 discrete trihedron. `law`: (fraction, scale) pairs of a
// homothetic law (Law_Interpol), empty for a constant section. `transition`: 0 transformed, 1 right corner (mitre), 2 round corner. The result is only
// returned when every probe point (xyz triples taken from the exact evaluator) lies within `check` of it: OCC's pipe shell is itself an approximation.
std::unique_ptr<Shape> pipe_shell_solid(rust::Slice<const double> spine, const Shape &section, int32_t mode, rust::Slice<const double> direction,
                                        rust::Slice<const double> law, int32_t transition, double tolerance, rust::Slice<const double> probes,
                                        double check, double volume) {
  try {
    const TopoDS_Wire wire = chain_wire(spine);
    if (wire.IsNull() || section.shape.ShapeType() != TopAbs_FACE) return nullptr;
    const TopoDS_Face face = TopoDS::Face(section.shape);
    if (unique_sub_shapes(face, TopAbs_WIRE).Extent() != 1) return nullptr;
    const TopoDS_Wire profile = BRepTools::OuterWire(face);
    BRepOffsetAPI_MakePipeShell shell(wire);
    switch (mode) {
      case 0:
        shell.SetMode(Standard_False);
        break;
      case 1:
        shell.SetMode(Standard_True);
        break;
      case 2:
        shell.SetMode(gp_Ax2(gp_Pnt(0, 0, 0), direction_of(direction)));
        break;
      case 3:
        shell.SetMode(direction_of(direction));
        break;
      case 4:
        shell.SetDiscreteMode();
        break;
      default:
        throw std::invalid_argument("pipe shell: unknown trihedron mode");
    }
    shell.SetTransitionMode(transition == 1 ? BRepBuilderAPI_RightCorner : transition == 2 ? BRepBuilderAPI_RoundCorner : BRepBuilderAPI_Transformed);
    shell.SetTolerance(tolerance, tolerance, 1e-2);
    if (law.size() >= 4 && law.size() % 2 == 0) {
      const int count = static_cast<int>(law.size() / 2);
      TColgp_Array1OfPnt2d pairs(1, count);
      for (int k = 0; k < count; ++k) pairs.SetValue(k + 1, gp_Pnt2d(law[2 * k], law[2 * k + 1]));
      Handle(Law_Interpol) scale = new Law_Interpol();
      scale->Set(pairs, Standard_False);
      shell.SetLaw(profile, scale, Standard_False, Standard_False);
    } else {
      shell.Add(profile, Standard_False, Standard_False);
    }
    shell.Build();
    if (!shell.IsDone() || !shell.MakeSolid()) return nullptr;
    const TopoDS_Shape solid = valid_or_null(shell.Shape());
    if (solid.IsNull()) return nullptr;
    // BRepExtrema from a point to a SOLID is 0 inside it, so the probes are measured to the faces: a pipe that is too fat misses them
    const TopTools_IndexedMapOfShape faces = unique_sub_shapes(solid, TopAbs_FACE);
    for (size_t k = 0; k + 2 < probes.size(); k += 3) {
      double nearest = std::numeric_limits<double>::infinity();
      for (int f = 1; f <= faces.Extent(); ++f)
        nearest = std::min(nearest, nearest_distance(faces(f), gp_Pnt(probes[k], probes[k + 1], probes[k + 2])));
      if (nearest > check) return nullptr;
    }
    GProp_GProps properties;
    BRepGProp::VolumeProperties(solid, properties);
    if (!(properties.Mass() > 0)) return nullptr;
    if (volume > 0 && std::abs(properties.Mass() - volume) > 1e-4 * volume) return nullptr;
    return wrap(solid);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
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
                                         rust::Slice<const double> normal, rust::Str tag) {
  const TopoDS_Shape face = polygon_face(profile);
  if (face.IsNull()) return nullptr;
  BRepFeat_MakeRevol maker;
  maker.Init(source.shape, face, TopoDS_Face(), gp_Ax1(point_at(origin, 0), direction_of(normal)), 0, Standard_True);
  maker.Perform(2 * M_PI);
  if (!maker.IsDone()) return nullptr;
  return feature_named(maker, source, face, std::string(tag));
}

std::unique_ptr<Shape> feature_prism_cut(const Shape &source, rust::Slice<const double> chain, rust::Slice<const double> origin,
                                         rust::Slice<const double> normal, rust::Slice<const double> probes, double length,
                                         rust::Str tag) {
  const gp_Dir frame_normal = direction_of(normal);
  const TopoDS_Shape sketch = supporting_face(source.shape, point_at(origin, 0), frame_normal, probes);
  const std::unique_ptr<Shape> profile = chain_face(chain);
  if (sketch.IsNull() || profile == nullptr) return nullptr;
  BRepFeat_MakePrism maker;
  maker.Init(source.shape, profile->shape, TopoDS::Face(sketch), frame_normal.Reversed(), 0, Standard_True);
  maker.Perform(length);
  if (!maker.IsDone()) return nullptr;
  return feature_named(maker, source, profile->shape, std::string(tag));
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
    const std::vector<naming::Named> inputs{naming::named(shape)};
    const TopoDS_Shape result = unifier.Shape();
    return keep_mass_rule(naming::wrap_named(result, naming::inherit(result, inputs, unifier.History(), "unify")), shape);
  } catch (const Standard_Failure &) {
    return keep_mass_rule(naming::wrap_named(shape.shape, naming::face_names(shape)), shape);
  }
}

}  // namespace llull

// Exact faces of a surface description with (u, v) trim loops, and constant-thickness slabs over such a face (AERO-5):
// - `surface_face`: a clamped B-spline surface (capability nurbsSurface: a sheet of the document) or an analytic plane / cylinder / cone, trimmed
//   by polygon loops in the surface parameter plane (pcurves on the surface, 3D curves built from them);
// - `face_slab`: the region of that face lifted along its normal from offset `from` to offset `to`: base face, face on Geom_OffsetSurface, one
//   ruled wall (BRepFill::Face) per loop edge, sewn into a solid. BRepOffsetAPI_MakeThickSolid is deliberately not used (it crashes on the
//   MinGW OCCT build, docs/decisions/SV1-solver-toolchain-windows.md).
// - `emboss_tools` / `split_shape` (03 WRP): one such slab (or trimmed face) per region of a text / logo, loops made of lines and B-spline pcurves; the
//   host fuses, cuts or splits the shape with them.
#include "llull-kernel-occt/cpp/features.hxx"

#include <cmath>
#include <stdexcept>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Builder.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Vec2d.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFill.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRep_Tool.hxx>
#include <GCE2d_MakeSegment.hxx>
#include <Geom2d_TrimmedCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_Plane.hxx>
#include <GProp_GProps.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Solid.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pnt2d.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/src/features.rs.h"

namespace llull {

namespace {

std::unique_ptr<Shape> wrap(const TopoDS_Shape &shape) {
  if (shape.IsNull()) return nullptr;
  return std::make_unique<Shape>(shape);
}

gp_Pnt point_at(rust::Slice<const double> values, size_t offset) {
  if (offset + 3 > values.size()) throw std::invalid_argument("surface: out of range");
  return gp_Pnt(values[offset], values[offset + 1], values[offset + 2]);
}

gp_Dir dir_at(rust::Slice<const double> values, size_t offset) {
  if (offset + 3 > values.size()) throw std::invalid_argument("surface: out of range");
  return gp_Dir(values[offset], values[offset + 1], values[offset + 2]);
}

// An integer count read from untrusted data: finite, integral and within [minimum, 100000] (a cast of anything else is undefined behaviour).
int count_of(double value, int minimum) {
  if (!(value >= minimum && value <= 100000.0) || value != std::floor(value)) throw std::invalid_argument("surface: a count is not an integer in range");
  return static_cast<int>(value);
}

enum SurfaceKind { kBSpline = 0, kPlane = 1, kCylinder = 2, kCone = 3 };

// Layout (see features.hxx): bspline = degU, degV, nU, nV, knotCountU, knotCountV, rational, poles (i-major), weights?, knotsU, multsU, knotsV, multsV.
Handle(Geom_Surface) bspline_surface(rust::Slice<const double> d) {
  if (d.size() < 7) throw std::invalid_argument("bspline surface: header too short");
  const int degree_u = count_of(d[0], 1), degree_v = count_of(d[1], 1);
  const int count_u = count_of(d[2], 2), count_v = count_of(d[3], 2);
  const int knots_u = count_of(d[4], 2), knots_v = count_of(d[5], 2);
  const bool rational = d[6] != 0.0;
  if (degree_u < 1 || degree_v < 1 || count_u < degree_u + 1 || count_v < degree_v + 1 || knots_u < 2 || knots_v < 2)
    throw std::invalid_argument("bspline surface: bad counts");
  const size_t pole_total = static_cast<size_t>(count_u) * static_cast<size_t>(count_v);
  const size_t expected = 7 + 3 * pole_total + (rational ? pole_total : 0) + 2 * static_cast<size_t>(knots_u + knots_v);
  if (d.size() != expected) throw std::invalid_argument("bspline surface: length mismatch");
  size_t offset = 7;
  TColgp_Array2OfPnt poles(1, count_u, 1, count_v);
  for (int i = 0; i < count_u; ++i)
    for (int j = 0; j < count_v; ++j) poles.SetValue(i + 1, j + 1, point_at(d, offset + 3 * (static_cast<size_t>(i) * count_v + j)));
  offset += 3 * pole_total;
  TColStd_Array2OfReal weights(1, count_u, 1, count_v);
  for (int i = 0; i < count_u; ++i)
    for (int j = 0; j < count_v; ++j) weights.SetValue(i + 1, j + 1, rational ? d[offset + static_cast<size_t>(i) * count_v + j] : 1.0);
  if (rational) offset += pole_total;
  const auto knot_array = [&](int count) {
    TColStd_Array1OfReal values(1, count);
    for (int k = 0; k < count; ++k) values.SetValue(k + 1, d[offset + static_cast<size_t>(k)]);
    offset += static_cast<size_t>(count);
    return values;
  };
  const auto multiplicity_array = [&](int count, int poles_in_direction, int degree) {
    TColStd_Array1OfInteger values(1, count);
    int total = 0;
    for (int k = 0; k < count; ++k) {
      values.SetValue(k + 1, count_of(d[offset + static_cast<size_t>(k)], 1));
      total += values(k + 1);
    }
    offset += static_cast<size_t>(count);
    if (total != poles_in_direction + degree + 1) throw std::invalid_argument("bspline surface: multiplicities do not fit the poles");
    return values;
  };
  const TColStd_Array1OfReal ku = knot_array(knots_u);
  const TColStd_Array1OfInteger mu = multiplicity_array(knots_u, count_u, degree_u);
  const TColStd_Array1OfReal kv = knot_array(knots_v);
  const TColStd_Array1OfInteger mv = multiplicity_array(knots_v, count_v, degree_v);
  if (rational) return new Geom_BSplineSurface(poles, weights, ku, kv, mu, mv, degree_u, degree_v);
  return new Geom_BSplineSurface(poles, ku, kv, mu, mv, degree_u, degree_v);
}

// plane: origin, xDir, yDir (chart u along xDir, v along yDir). cylinder: origin, axis, xDir, radius (u = azimuth about axis from xDir, v = axial).
// cone: apex, axis, xDir, semi-angle (u = azimuth, v = distance from the apex along the generator).
Handle(Geom_Surface) make_surface(int kind, rust::Slice<const double> d) {
  switch (kind) {
    case kBSpline:
      return bspline_surface(d);
    case kPlane: {
      const gp_Dir x = dir_at(d, 3), y = dir_at(d, 6);
      return new Geom_Plane(gp_Ax3(point_at(d, 0), x.Crossed(y), x));
    }
    case kCylinder:
      if (d.size() != 10 || !(d[9] > 0)) throw std::invalid_argument("cylinder: bad data");
      return new Geom_CylindricalSurface(gp_Ax3(point_at(d, 0), dir_at(d, 3), dir_at(d, 6)), d[9]);
    case kCone:
      if (d.size() != 10 || !(d[9] > 0)) throw std::invalid_argument("cone: bad data");
      return new Geom_ConicalSurface(gp_Ax3(point_at(d, 0), dir_at(d, 3), dir_at(d, 6)), d[9], 0.0);
    default:
      throw std::invalid_argument("surface: unknown kind");
  }
}

// One piece of a loop in the surface's (u, v) plane: a pcurve (a segment or a B-spline) running from `from` to `to`.
struct Segment {
  Handle(Geom2d_Curve) curve;
  gp_Pnt2d from;
  gp_Pnt2d to;
};

struct Loop {
  bool outer;
  std::vector<Segment> segments;
};

Segment line_segment(const gp_Pnt2d &a, const gp_Pnt2d &b) {
  GCE2d_MakeSegment segment(a, b);
  if (!segment.IsDone()) throw std::invalid_argument("loop: degenerate segment");
  const Handle(Geom2d_Curve) curve(segment.Value());
  return Segment{curve, a, b};
}

// loops: count, then per loop: point count, outer flag (1 / 0), u v pairs.
std::vector<Loop> read_loops(rust::Slice<const double> d) {
  std::vector<Loop> loops;
  if (d.empty()) return loops;
  size_t offset = 1;
  const size_t count = static_cast<size_t>(count_of(d[0], 1));
  size_t outer_loops = 0;
  for (size_t k = 0; k < count; ++k) {
    if (offset + 2 > d.size()) throw std::invalid_argument("loops: truncated");
    const size_t n = static_cast<size_t>(count_of(d[offset], 3));
    if (d[offset + 1] != 0.0 && d[offset + 1] != 1.0) throw std::invalid_argument("loops: the outer flag must be 0 or 1");
    const bool outer = d[offset + 1] == 1.0;
    if (outer) ++outer_loops;
    offset += 2;
    if (offset + 2 * n > d.size()) throw std::invalid_argument("loops: bad point count");
    std::vector<gp_Pnt2d> points;
    for (size_t i = 0; i < n; ++i) points.emplace_back(d[offset + 2 * i], d[offset + 2 * i + 1]);
    offset += 2 * n;
    Loop loop{outer, {}};
    for (size_t i = 0; i < n; ++i) {
      const gp_Pnt2d &a = points[i];
      const gp_Pnt2d &b = points[(i + 1) % n];
      if (a.Distance(b) >= 1e-12) loop.segments.push_back(line_segment(a, b));
    }
    loops.push_back(loop);
  }
  if (offset != d.size() || outer_loops != 1) throw std::invalid_argument("loops: exactly one outer loop and no trailing data");
  return loops;
}

// Reads the numbers of a flat list in order, every access and count bounded (the list comes from a stored document).
class Cursor {
 public:
  explicit Cursor(rust::Slice<const double> data) : data_(data) {}
  double next() {
    if (at_ >= data_.size()) throw std::invalid_argument("regions: the list ends early");
    const double value = data_[at_++];
    if (!std::isfinite(value)) throw std::invalid_argument("regions: a number is not finite");
    return value;
  }
  int count(int minimum, int maximum) {
    const double value = next();
    if (!(value >= minimum && value <= maximum) || value != std::floor(value)) throw std::invalid_argument("regions: a count is not an integer in range");
    return static_cast<int>(value);
  }
  bool flag() {
    const double value = next();
    if (value != 0.0 && value != 1.0) throw std::invalid_argument("regions: a flag must be 0 or 1");
    return value == 1.0;
  }
  bool done() const { return at_ == data_.size(); }

 private:
  rust::Slice<const double> data_;
  size_t at_ = 0;
};

constexpr double kJoin = 1e-7;

// degree, pole count, rational flag, knot count, poles (u v), weights (rational only), knots, multiplicities.
Handle(Geom2d_BSplineCurve) read_pcurve(Cursor &in) {
  const int degree = in.count(1, 25);
  const int pole_count = in.count(2, 2000);
  const bool rational = in.flag();
  const int knot_count = in.count(2, 2100);
  TColgp_Array1OfPnt2d poles(1, pole_count);
  for (int i = 1; i <= pole_count; ++i) {
    const double u = in.next();
    const double v = in.next();
    poles.SetValue(i, gp_Pnt2d(u, v));
  }
  TColStd_Array1OfReal weights(1, pole_count);
  for (int i = 1; i <= pole_count; ++i) {
    const double weight = rational ? in.next() : 1.0;
    if (!(weight > 0)) throw std::invalid_argument("regions: a weight must be > 0");
    weights.SetValue(i, weight);
  }
  TColStd_Array1OfReal knots(1, knot_count);
  for (int i = 1; i <= knot_count; ++i) {
    knots.SetValue(i, in.next());
    if (i > 1 && !(knots(i) > knots(i - 1))) throw std::invalid_argument("regions: knots must increase");
  }
  TColStd_Array1OfInteger multiplicities(1, knot_count);
  long total = 0;
  for (int i = 1; i <= knot_count; ++i) {
    multiplicities.SetValue(i, in.count(1, degree + 1));
    total += multiplicities(i);
  }
  if (total != pole_count + degree + 1) throw std::invalid_argument("regions: multiplicities do not fit the poles");
  if (rational) return new Geom2d_BSplineCurve(poles, weights, knots, multiplicities, degree);
  return new Geom2d_BSplineCurve(poles, knots, multiplicities, degree);
}

constexpr int kMaxRegions = 20000;
constexpr size_t kMaxSegments = 400000;

// regions: count, then per region its loop count and per loop: outer flag, start u v, segment count and per segment a kind (0 line: end u v;
// 1 B-spline pcurve: see read_pcurve). Every loop closes on its start; every region has exactly one outer loop.
std::vector<std::vector<Loop>> read_regions(rust::Slice<const double> d) {
  Cursor in(d);
  const int region_count = in.count(1, kMaxRegions);
  std::vector<std::vector<Loop>> regions;
  size_t budget = 0;
  for (int r = 0; r < region_count; ++r) {
    const int loop_count = in.count(1, 4096);
    std::vector<Loop> region;
    int outers = 0;
    for (int l = 0; l < loop_count; ++l) {
      Loop loop{in.flag(), {}};
      outers += loop.outer ? 1 : 0;
      const double start_u = in.next();
      const double start_v = in.next();
      const gp_Pnt2d start(start_u, start_v);
      gp_Pnt2d cursor = start;
      const int segment_count = in.count(1, 100000);
      budget += static_cast<size_t>(segment_count);
      if (budget > kMaxSegments) throw std::invalid_argument("regions: too many loop segments");
      for (int s = 0; s < segment_count; ++s) {
        const int kind = in.count(0, 1);
        if (kind == 0) {
          const double u = in.next();
          const double v = in.next();
          const gp_Pnt2d end(u, v);
          if (cursor.Distance(end) >= 1e-12) loop.segments.push_back(line_segment(cursor, end));
          cursor = end;
        } else {
          const Handle(Geom2d_BSplineCurve) curve = read_pcurve(in);
          if (curve->StartPoint().Distance(cursor) > kJoin) throw std::invalid_argument("regions: a curve does not start where the loop is");
          loop.segments.push_back(Segment{curve, curve->StartPoint(), curve->EndPoint()});
          cursor = curve->EndPoint();
        }
      }
      if (cursor.Distance(start) > kJoin || loop.segments.empty()) throw std::invalid_argument("regions: a loop must close on its start");
      region.push_back(loop);
    }
    if (outers != 1) throw std::invalid_argument("regions: every region needs exactly one outer loop");
    regions.push_back(region);
  }
  if (!in.done()) throw std::invalid_argument("regions: trailing data");
  return regions;
}

// The closed loop as pcurve edges on `surface` (shared vertices); `edges` receives them in loop order.
TopoDS_Wire loop_wire(const Handle(Geom_Surface) & surface, const Loop &loop, std::vector<TopoDS_Edge> &edges) {
  std::vector<TopoDS_Vertex> vertices;
  std::vector<gp_Pnt> locations;
  // a periodic seam (or a collapsed pole) maps several loop points to one 3D point: they share one vertex, so the edge between is closed
  const auto vertex_at = [&](const gp_Pnt2d &p) -> TopoDS_Vertex {
    const gp_Pnt at = surface->Value(p.X(), p.Y());
    for (size_t k = 0; k < locations.size(); ++k)
      if (locations[k].Distance(at) < 1e-9) return vertices[k];
    locations.push_back(at);
    vertices.push_back(BRepBuilderAPI_MakeVertex(at));
    return vertices.back();
  };
  BRepBuilderAPI_MakeWire wire;
  for (const Segment &segment : loop.segments) {
    const TopoDS_Vertex first = vertex_at(segment.from);
    const TopoDS_Vertex last = vertex_at(segment.to);
    BRepBuilderAPI_MakeEdge edge(segment.curve, surface, first, last, segment.curve->FirstParameter(), segment.curve->LastParameter());
    if (!edge.IsDone()) return TopoDS_Wire();
    BRepLib::BuildCurves3d(edge.Edge(), 1e-7);
    edges.push_back(edge.Edge());
    wire.Add(edge.Edge());
    if (!wire.IsDone()) return TopoDS_Wire();
  }
  return wire.IsDone() ? wire.Wire() : TopoDS_Wire();
}

// The face of `surface` bounded by the loops (one outer, any holes); with no outer loop a B-spline keeps its natural boundary.
TopoDS_Face trimmed_face(const Handle(Geom_Surface) & surface, const std::vector<Loop> &loops, std::vector<std::vector<TopoDS_Edge>> *edge_loops) {
  const Loop *outer = nullptr;
  for (const Loop &loop : loops) {
    if (!loop.outer) continue;
    if (outer != nullptr) throw std::invalid_argument("face: more than one outer loop");
    outer = &loop;
  }
  std::vector<std::vector<TopoDS_Edge>> scratch;
  std::vector<std::vector<TopoDS_Edge>> &collected = edge_loops == nullptr ? scratch : *edge_loops;
  if (outer == nullptr && surface->DynamicType() != STANDARD_TYPE(Geom_BSplineSurface)) throw std::invalid_argument("face: an analytic surface needs an outer loop");
  BRepBuilderAPI_MakeFace maker;
  if (outer == nullptr) {
    maker.Init(surface, Standard_True, 1e-7);
  } else {
    collected.emplace_back();
    const TopoDS_Wire wire = loop_wire(surface, *outer, collected.back());
    if (wire.IsNull()) return TopoDS_Face();
    maker.Init(surface, Standard_False, 1e-7);
    maker.Add(wire);
  }
  for (const Loop &loop : loops) {
    if (&loop == outer) continue;
    collected.emplace_back();
    const TopoDS_Wire wire = loop_wire(surface, loop, collected.back());
    if (wire.IsNull()) return TopoDS_Face();
    maker.Add(wire);
  }
  if (!maker.IsDone()) return TopoDS_Face();
  ShapeFix_Face fix(maker.Face());
  fix.FixOrientation();
  fix.Perform();
  const TopoDS_Face face = fix.Face();
  BRepLib::SameParameter(face, 1e-7);
  return face;
}

// The surface at signed offset `distance` along its normal Su x Sv, with the shift of v that keeps (u, v) on the same normal line. Analytic
// kinds stay analytic (plane moved, cylinder radius + d, cone moved to apex - d / sin(a) with v + d cot(a)); a B-spline becomes a Geom_OffsetSurface.
struct Lift {
  Handle(Geom_Surface) surface;
  double v_shift;
};

Lift lift(int kind, rust::Slice<const double> d, const Handle(Geom_Surface) & base, double distance) {
  if (distance == 0.0) return Lift{base, 0.0};
  switch (kind) {
    case kPlane: {
      const gp_Dir x = dir_at(d, 3), y = dir_at(d, 6);
      const gp_Dir normal = x.Crossed(y);
      return Lift{new Geom_Plane(gp_Ax3(point_at(d, 0).Translated(gp_Vec(normal) * distance), normal, x)), 0.0};
    }
    case kCylinder: {
      if (!(d[9] + distance > 0)) throw std::invalid_argument("cylinder: the offset collapses the radius");
      return Lift{new Geom_CylindricalSurface(gp_Ax3(point_at(d, 0), dir_at(d, 3), dir_at(d, 6)), d[9] + distance), 0.0};
    }
    case kCone: {
      const double angle = d[9];
      const gp_Dir axis = dir_at(d, 3);
      const gp_Pnt apex = point_at(d, 0).Translated(gp_Vec(axis) * (-distance / std::sin(angle)));
      return Lift{new Geom_ConicalSurface(gp_Ax3(apex, axis, dir_at(d, 6)), angle, 0.0), distance * std::cos(angle) / std::sin(angle)};
    }
    default:
      return Lift{new Geom_OffsetSurface(base, distance), 0.0};
  }
}

std::vector<Loop> shifted(const std::vector<Loop> &loops, double v_shift) {
  std::vector<Loop> out;
  for (const Loop &loop : loops) {
    Loop moved{loop.outer, {}};
    for (const Segment &segment : loop.segments) {
      Handle(Geom2d_Curve) curve = Handle(Geom2d_Curve)::DownCast(segment.curve->Copy());
      curve->Translate(gp_Vec2d(0.0, v_shift));
      moved.segments.push_back(Segment{curve, gp_Pnt2d(segment.from.X(), segment.from.Y() + v_shift), gp_Pnt2d(segment.to.X(), segment.to.Y() + v_shift)});
    }
    out.push_back(moved);
  }
  return out;
}

// True when every segment of every loop stays at v > 0 (cone: the lift must not carry a loop through the apex); curves are probed along their length.
bool above_apex(const std::vector<Loop> &loops) {
  for (const Loop &loop : loops)
    for (const Segment &segment : loop.segments) {
      const double first = segment.curve->FirstParameter();
      const double last = segment.curve->LastParameter();
      for (int k = 0; k <= 8; ++k)
        if (!(segment.curve->Value(first + (last - first) * k / 8.0).Y() > 0)) return false;
    }
  return true;
}

// The slab: the face of `kind` bounded by `boundary` lifted along its normal from offset `from` to `to` (null shape when OCC refuses).
TopoDS_Shape build_slab(int32_t kind, rust::Slice<const double> surface, const std::vector<Loop> &given, double from, double to,
                        rust::Slice<const double> direction, double tolerance) {
  if (!(to > from) || direction.size() != 3) return TopoDS_Shape();
  const Handle(Geom_Surface) base = make_surface(kind, surface);
  std::vector<Loop> boundary = given;
  if (boundary.empty() && kind == kBSpline) {
    // the natural boundary of a sheet: its parameter rectangle (the walls need explicit edges)
    double u0, u1, v0, v1;
    base->Bounds(u0, u1, v0, v1);
    const gp_Pnt2d corners[4] = {gp_Pnt2d(u0, v0), gp_Pnt2d(u1, v0), gp_Pnt2d(u1, v1), gp_Pnt2d(u0, v1)};
    Loop rectangle{true, {}};
    for (int k = 0; k < 4; ++k) rectangle.segments.push_back(line_segment(corners[k], corners[(k + 1) % 4]));
    boundary.push_back(rectangle);
  }
  if (boundary.empty() || !boundary.front().outer || boundary.front().segments.empty()) return TopoDS_Shape();
  // offsets run along the surface normal; the reference direction (the wanted lift direction at the first loop vertex) fixes its sign
  const gp_Pnt2d &start = boundary.front().segments.front().from;
  gp_Pnt at;
  gp_Vec du, dv;
  base->D1(start.X(), start.Y(), at, du, dv);
  const gp_Vec normal = du.Crossed(dv);
  // a singular point (a pole, an apex) has no normal: the sign of the lift would be arbitrary
  if (normal.Magnitude() <= 1e-9 * (du.Magnitude() * dv.Magnitude()) || normal.Magnitude() < 1e-300) return TopoDS_Shape();
  const double sign = normal.Dot(gp_Vec(direction[0], direction[1], direction[2])) >= 0 ? 1.0 : -1.0;
  const Lift low = lift(kind, surface, base, sign * from);
  const Lift high = lift(kind, surface, base, sign * to);
  const std::vector<Loop> low_loops = shifted(boundary, low.v_shift);
  const std::vector<Loop> high_loops = shifted(boundary, high.v_shift);
  if (kind == kCone && (!above_apex(low_loops) || !above_apex(high_loops))) return TopoDS_Shape();  // the lift would carry a loop through (or past) the apex
  std::vector<std::vector<TopoDS_Edge>> bottom_edges, top_edges;
  const TopoDS_Face bottom = trimmed_face(low.surface, low_loops, &bottom_edges);
  const TopoDS_Face top = trimmed_face(high.surface, high_loops, &top_edges);
  if (bottom.IsNull() || top.IsNull()) return TopoDS_Shape();
  BRepBuilderAPI_Sewing sewing(tolerance, Standard_True, Standard_True, Standard_True, Standard_False);
  sewing.Add(bottom);
  sewing.Add(top);
  for (size_t k = 0; k < bottom_edges.size(); ++k) {
    const std::vector<TopoDS_Edge> &lower = bottom_edges[k];
    const std::vector<TopoDS_Edge> &upper = top_edges[k];
    std::vector<bool> seam(lower.size(), false);
    // a full-turn periodic face has two coincident boundary edges (u = 0 and u = period): their walls would overlap, so neither is built
    for (size_t i = 0; i < lower.size(); ++i) {
      if (seam[i]) continue;
      BRepAdaptor_Curve ci(lower[i]);
      const gp_Pnt mid_i = ci.Value(0.5 * (ci.FirstParameter() + ci.LastParameter()));
      for (size_t j = i + 1; j < lower.size(); ++j) {
        BRepAdaptor_Curve cj(lower[j]);
        const gp_Pnt mid_j = cj.Value(0.5 * (cj.FirstParameter() + cj.LastParameter()));
        if (mid_i.Distance(mid_j) < tolerance && ci.Value(ci.FirstParameter()).Distance(cj.Value(cj.LastParameter())) < tolerance) {
          seam[i] = seam[j] = true;
          break;
        }
      }
    }
    for (size_t i = 0; i < lower.size(); ++i) {
      if (seam[i]) continue;
      const TopoDS_Face wall = BRepFill::Face(lower[i], upper[i]);
      if (wall.IsNull()) return TopoDS_Shape();
      sewing.Add(wall);
    }
  }
  sewing.Perform();
  if (sewing.NbFreeEdges() > 0) return TopoDS_Shape();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) return TopoDS_Shape();
  BRepBuilderAPI_MakeSolid solid;
  int shells = 0;
  for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
    solid.Add(TopoDS::Shell(shell.Current()));
    ++shells;
  }
  if (shells != 1) return TopoDS_Shape();
  solid.Build();
  if (!solid.IsDone()) return TopoDS_Shape();
  ShapeFix_Solid fix(solid.Solid());
  fix.Perform();
  const TopoDS_Shape result = fix.Solid();
  // never hand back a broken or inside-out slab: the host falls back to the triangles
  if (!BRepCheck_Analyzer(result, Standard_True).IsValid()) return TopoDS_Shape();
  GProp_GProps properties;
  BRepGProp::VolumeProperties(result, properties);
  if (!(properties.Mass() > 0)) return TopoDS_Shape();
  return result;
}

}  // namespace

std::unique_ptr<Shape> surface_face(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops) {
  try {
    const TopoDS_Face face = trimmed_face(make_surface(kind, surface), read_loops(loops), nullptr);
    return face.IsNull() ? nullptr : wrap(face);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

std::unique_ptr<Shape> face_slab(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> loops, double from, double to,
                                 rust::Slice<const double> direction, double tolerance) {
  try {
    const TopoDS_Shape slab = build_slab(kind, surface, read_loops(loops), from, to, direction, tolerance);
    return slab.IsNull() ? nullptr : wrap(slab);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

// One tool per region: the slab between offsets `from` and `to` (a solid), or with `faces_only` the trimmed face itself (scribe). A compound of them.
std::unique_ptr<Shape> emboss_tools(int32_t kind, rust::Slice<const double> surface, rust::Slice<const double> regions, double from, double to,
                                    rust::Slice<const double> direction, double tolerance, bool faces_only) {
  try {
    const Handle(Geom_Surface) base = make_surface(kind, surface);
    TopoDS_Compound compound;
    BRep_Builder builder;
    builder.MakeCompound(compound);
    for (const std::vector<Loop> &region : read_regions(regions)) {
      const TopoDS_Shape part = faces_only ? TopoDS_Shape(trimmed_face(base, region, nullptr)) : build_slab(kind, surface, region, from, to, direction, tolerance);
      if (part.IsNull()) return nullptr;
      builder.Add(compound, part);
    }
    return wrap(compound);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

// `source` split by the faces of `tools` (BOPAlgo splitter): the faces they share with the source divide it, no material changes. Names follow the history.
std::unique_ptr<Shape> split_shape(const Shape &source, const Shape &tools) {
  try {
    TopTools_ListOfShape arguments, parts;
    arguments.Append(source.shape);
    for (TopoDS_Iterator part(tools.shape); part.More(); part.Next()) parts.Append(part.Value());
    BRepAlgoAPI_Splitter splitter;
    splitter.SetArguments(arguments);
    splitter.SetTools(parts);
    splitter.Build();
    if (!splitter.IsDone() || splitter.HasErrors()) return nullptr;
    TopoDS_Shape result = splitter.Shape();
    int solids = 0;
    TopoDS_Shape only;
    for (TopExp_Explorer solid(result, TopAbs_SOLID); solid.More(); solid.Next()) {
      only = solid.Current();
      ++solids;
    }
    if (solids == 1) result = only;
    const std::vector<naming::Named> inputs{naming::named(source)};
    std::vector<std::string> names = naming::inherit(result, inputs, splitter.History(), "scribe");
    // A patch that crosses the seam of a periodic face is cut in two by the seam edge: put such halves back together, keeping the scribed outline itself
    TopTools_MapOfShape keep;
    for (TopExp_Explorer edge(tools.shape, TopAbs_EDGE); edge.More(); edge.Next()) {
      const TopoDS_Shape &tool_edge = edge.Current();
      const TopTools_ListOfShape &modified = splitter.Modified(tool_edge);
      if (modified.IsEmpty() && !splitter.IsDeleted(tool_edge)) keep.Add(tool_edge);
      for (TopTools_ListIteratorOfListOfShape it(modified); it.More(); it.Next()) keep.Add(it.Value());
    }
    try {
      ShapeUpgrade_UnifySameDomain unifier(result, Standard_False, Standard_True, Standard_False);
      unifier.KeepShapes(keep);
      unifier.AllowInternalEdges(Standard_False);
      unifier.Build();
      const std::vector<naming::Named> split{naming::Named{result, names}};
      return naming::wrap_named(unifier.Shape(), naming::inherit(unifier.Shape(), split, unifier.History(), "unify"));
    } catch (const Standard_Failure &) {
      return naming::wrap_named(result, std::move(names));
    }
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

std::unique_ptr<Shape> sheet_solid(rust::Slice<const double> faces, rust::Slice<const uint32_t> lengths, double tolerance) {
  try {
    std::vector<TopoDS_Shape> sides;
    size_t offset = 0;
    for (uint32_t length : lengths) {
      if (offset + length > faces.size()) throw std::invalid_argument("sheet solid: face lengths overrun");
      const TopoDS_Face face = trimmed_face(make_surface(kBSpline, rust::Slice<const double>(faces.data() + offset, length)), {}, nullptr);
      if (face.IsNull()) return nullptr;
      sides.push_back(face);
      offset += length;
    }
    if (sides.empty()) return nullptr;
    // the lateral shell leaves exactly two closed free boundaries (the first and last section): each is closed by a planar cap
    BRepBuilderAPI_Sewing lateral(tolerance, Standard_True, Standard_True, Standard_True, Standard_False);
    for (const TopoDS_Shape &face : sides) lateral.Add(face);
    lateral.Perform();
    const TopoDS_Shape shell = lateral.SewedShape();
    if (shell.IsNull()) return nullptr;
    ShapeAnalysis_FreeBounds bounds(shell, tolerance, Standard_True, Standard_False);
    int caps = 0;
    std::vector<TopoDS_Shape> all = sides;
    for (TopExp_Explorer wire(bounds.GetClosedWires(), TopAbs_WIRE); wire.More(); wire.Next(), ++caps) {
      BRepBuilderAPI_MakeFace cap(TopoDS::Wire(wire.Current()), Standard_True);
      if (!cap.IsDone()) return nullptr;
      all.push_back(cap.Face());
    }
    if (caps != 2) throw std::invalid_argument("sheet solid: expected 2 closed section boundaries, found " + std::to_string(caps));
    BRepBuilderAPI_Sewing sewing(tolerance, Standard_True, Standard_True, Standard_True, Standard_False);
    for (const TopoDS_Shape &face : all) sewing.Add(face);
    sewing.Perform();
    if (sewing.NbFreeEdges() > 0)
      throw std::invalid_argument("SWG_KERNEL_SEW_OPEN: sewing left " + std::to_string(sewing.NbFreeEdges()) + " free edge(s)");
    const TopoDS_Shape sewn = sewing.SewedShape();
    if (sewn.IsNull()) return nullptr;
    BRepBuilderAPI_MakeSolid solid;
    int shells = 0;
    for (TopExp_Explorer it(sewn, TopAbs_SHELL); it.More(); it.Next()) {
      solid.Add(TopoDS::Shell(it.Current()));
      ++shells;
    }
    if (shells != 1) return nullptr;
    solid.Build();
    if (!solid.IsDone()) return nullptr;
    ShapeFix_Solid fix(solid.Solid());
    fix.Perform();
    const TopoDS_Shape result = fix.Solid();
    if (!BRepCheck_Analyzer(result, Standard_True).IsValid()) return nullptr;
    GProp_GProps properties;
    BRepGProp::VolumeProperties(result, properties);
    if (!(properties.Mass() > 0)) return nullptr;
    return wrap(result);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

}  // namespace llull

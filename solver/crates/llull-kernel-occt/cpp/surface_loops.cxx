// Readers of the surface and (u, v) loop descriptions the face commands send (03 WRP, AERO-5): the analytic and B-spline surfaces of
// `features.hxx`, trim loops, emboss regions and open pcurve chains, and the loop wires on a surface. Every count and join is checked: the lists come
// from stored documents.
#include "llull-kernel-occt/cpp/surface_loops.hxx"

#include <cmath>
#include <stdexcept>

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepLib.hxx>
#include <GCE2d_MakeSegment.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <gp_Ax3.hxx>

namespace llull {
namespace surface_wire {

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
// sphere: centre, axis, xDir, radius (u = azimuth, v = latitude). torus: centre, axis, xDir, major radius, minor radius (u = azimuth about the axis, v = angle round the tube).
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
    case kSphere:
      if (d.size() != 10 || !(d[9] > 0)) throw std::invalid_argument("sphere: bad data");
      return new Geom_SphericalSurface(gp_Ax3(point_at(d, 0), dir_at(d, 3), dir_at(d, 6)), d[9]);
    case kTorus:
      if (d.size() != 11 || !(d[9] > 0) || !(d[10] > 0)) throw std::invalid_argument("torus: bad data");
      return new Geom_ToroidalSurface(gp_Ax3(point_at(d, 0), dir_at(d, 3), dir_at(d, 6)), d[9], d[10]);
    default:
      throw std::invalid_argument("surface: unknown kind");
  }
}

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

// One loop: start u v, segment count and per segment a kind (0 line: end u v; 1 B-spline pcurve: see read_pcurve). A closed loop ends on its start; an open chain need not.
Loop read_loop(Cursor &in, bool outer, bool closed, size_t &budget) {
  Loop loop{outer, {}};
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
  if (loop.segments.empty() || (closed && cursor.Distance(start) > kJoin)) throw std::invalid_argument("regions: a loop must close on its start");
  return loop;
}

// regions: count, then per region its loop count and per loop an outer flag followed by a closed loop (see read_loop). Every region has exactly one outer loop.
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
      const bool outer = in.flag();
      outers += outer ? 1 : 0;
      region.push_back(read_loop(in, outer, true, budget));
    }
    if (outers != 1) throw std::invalid_argument("regions: every region needs exactly one outer loop");
    regions.push_back(region);
  }
  if (!in.done()) throw std::invalid_argument("regions: trailing data");
  return regions;
}

// chains: count, then per chain an open (or closed) pcurve chain (see read_loop, no closure required).
std::vector<Loop> read_chains(rust::Slice<const double> d) {
  Cursor in(d);
  const int count = in.count(1, kMaxRegions);
  std::vector<Loop> chains;
  size_t budget = 0;
  for (int k = 0; k < count; ++k) chains.push_back(read_loop(in, false, false, budget));
  if (!in.done()) throw std::invalid_argument("chains: trailing data");
  return chains;
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

}  // namespace surface_wire
}  // namespace llull

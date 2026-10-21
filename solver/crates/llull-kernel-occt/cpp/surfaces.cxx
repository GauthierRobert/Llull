// Exact faces of a surface description with (u, v) trim loops, and constant-thickness slabs over such a face (AERO-5):
// - `surface_face`: a clamped B-spline surface (capability nurbsSurface: a sheet of the document) or an analytic plane / cylinder / cone, trimmed
//   by polygon loops in the surface parameter plane (pcurves on the surface, 3D curves built from them);
// - `face_slab`: the region of that face lifted along its normal from offset `from` to offset `to`: base face, face on Geom_OffsetSurface, one
//   ruled wall (BRepFill::Face) per loop edge, sewn into a solid. BRepOffsetAPI_MakeThickSolid is deliberately not used (it crashes on the
//   MinGW OCCT build, docs/decisions/SV1-solver-toolchain-windows.md).
#include "llull-kernel-occt/cpp/features.hxx"

#include <cmath>
#include <stdexcept>

#include <BRepAdaptor_Curve.hxx>
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
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Solid.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pnt2d.hxx>

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

struct Loop {
  bool outer;
  std::vector<gp_Pnt2d> points;
};

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
    Loop loop{outer, {}};
    for (size_t i = 0; i < n; ++i) loop.points.emplace_back(d[offset + 2 * i], d[offset + 2 * i + 1]);
    offset += 2 * n;
    loops.push_back(loop);
  }
  if (offset != d.size() || outer_loops != 1) throw std::invalid_argument("loops: exactly one outer loop and no trailing data");
  return loops;
}

// The closed polygon of `points` as pcurve edges on `surface` (shared vertices); `edges` receives them in loop order.
TopoDS_Wire loop_wire(const Handle(Geom_Surface) & surface, const std::vector<gp_Pnt2d> &points, std::vector<TopoDS_Edge> &edges) {
  std::vector<TopoDS_Vertex> vertices;
  std::vector<gp_Pnt> locations;
  for (const gp_Pnt2d &p : points) {
    // a periodic seam (or a collapsed pole) maps several loop points to one 3D point: they share one vertex, so the edge between is closed
    const gp_Pnt at = surface->Value(p.X(), p.Y());
    size_t found = locations.size();
    for (size_t k = 0; k < locations.size(); ++k)
      if (locations[k].Distance(at) < 1e-9) {
        found = k;
        break;
      }
    if (found == locations.size()) {
      locations.push_back(at);
      vertices.push_back(BRepBuilderAPI_MakeVertex(at));
    } else {
      locations.push_back(at);
      vertices.push_back(vertices[found]);
    }
  }
  BRepBuilderAPI_MakeWire wire;
  const size_t n = points.size();
  for (size_t i = 0; i < n; ++i) {
    const size_t j = (i + 1) % n;
    if (points[i].Distance(points[j]) < 1e-12) continue;
    GCE2d_MakeSegment segment(points[i], points[j]);
    if (!segment.IsDone()) throw std::invalid_argument("loop: degenerate segment");
    const Handle(Geom2d_Curve) curve(segment.Value());
    BRepBuilderAPI_MakeEdge edge(curve, surface, vertices[i], vertices[j], curve->FirstParameter(), curve->LastParameter());
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
    const TopoDS_Wire wire = loop_wire(surface, outer->points, collected.back());
    if (wire.IsNull()) return TopoDS_Face();
    maker.Init(surface, Standard_False, 1e-7);
    maker.Add(wire);
  }
  for (const Loop &loop : loops) {
    if (&loop == outer) continue;
    collected.emplace_back();
    const TopoDS_Wire wire = loop_wire(surface, loop.points, collected.back());
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
  std::vector<Loop> out = loops;
  for (Loop &loop : out)
    for (gp_Pnt2d &p : loop.points) p.SetY(p.Y() + v_shift);
  return out;
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
    if (!(to > from) || direction.size() != 3) return nullptr;
    const Handle(Geom_Surface) base = make_surface(kind, surface);
    std::vector<Loop> boundary = read_loops(loops);
    if (boundary.empty() && kind == kBSpline) {
      // the natural boundary of a sheet: its parameter rectangle (the walls need explicit edges)
      double u0, u1, v0, v1;
      base->Bounds(u0, u1, v0, v1);
      boundary.push_back(Loop{true, {gp_Pnt2d(u0, v0), gp_Pnt2d(u1, v0), gp_Pnt2d(u1, v1), gp_Pnt2d(u0, v1)}});
    }
    if (boundary.empty() || !boundary.front().outer) return nullptr;
    // offsets run along the surface normal; the reference direction (the wanted lift direction at the first loop vertex) fixes its sign
    const gp_Pnt2d &start = boundary.front().points.front();
    gp_Pnt at;
    gp_Vec du, dv;
    base->D1(start.X(), start.Y(), at, du, dv);
    const gp_Vec normal = du.Crossed(dv);
    // a singular point (a pole, an apex) has no normal: the sign of the lift would be arbitrary
    if (normal.Magnitude() <= 1e-9 * (du.Magnitude() * dv.Magnitude()) || normal.Magnitude() < 1e-300) return nullptr;
    const double sign = normal.Dot(gp_Vec(direction[0], direction[1], direction[2])) >= 0 ? 1.0 : -1.0;
    const Lift low = lift(kind, surface, base, sign * from);
    const Lift high = lift(kind, surface, base, sign * to);
    const std::vector<Loop> low_loops = shifted(boundary, low.v_shift);
    const std::vector<Loop> high_loops = shifted(boundary, high.v_shift);
    if (kind == kCone)
      for (const std::vector<Loop> *loops_of : {&low_loops, &high_loops})
        for (const Loop &loop : *loops_of)
          for (const gp_Pnt2d &p : loop.points)
            if (!(p.Y() > 0)) return nullptr;  // the lift would carry a loop through (or past) the apex
    std::vector<std::vector<TopoDS_Edge>> bottom_edges, top_edges;
    const TopoDS_Face bottom = trimmed_face(low.surface, low_loops, &bottom_edges);
    const TopoDS_Face top = trimmed_face(high.surface, high_loops, &top_edges);
    if (bottom.IsNull() || top.IsNull()) return nullptr;
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
        if (wall.IsNull()) return nullptr;
        sewing.Add(wall);
      }
    }
    sewing.Perform();
    if (sewing.NbFreeEdges() > 0) return nullptr;
    const TopoDS_Shape sewn = sewing.SewedShape();
    if (sewn.IsNull()) return nullptr;
    BRepBuilderAPI_MakeSolid solid;
    int shells = 0;
    for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
      solid.Add(TopoDS::Shell(shell.Current()));
      ++shells;
    }
    if (shells != 1) return nullptr;
    solid.Build();
    if (!solid.IsDone()) return nullptr;
    ShapeFix_Solid fix(solid.Solid());
    fix.Perform();
    const TopoDS_Shape result = fix.Solid();
    // never hand back a broken or inside-out slab: the host falls back to the triangles
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

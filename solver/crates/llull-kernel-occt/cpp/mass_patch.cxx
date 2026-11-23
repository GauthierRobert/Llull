#include "llull-kernel-occt/cpp/mass_patch.hxx"

#include "llull-kernel-occt/cpp/mass_spans.hxx"
#include "llull-kernel-occt/cpp/mass_patch_basis.hxx"
#include "llull-kernel-occt/cpp/mass_patch_pieces.hxx"

#include <BRepAdaptor_Curve2d.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Domain.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepGProp_Vinert.hxx>
#include <BRep_Builder.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Mat.hxx>
#include <TopLoc_Location.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <gp_XYZ.hxx>

#include <Standard_Failure.hxx>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <exception>
#include <memory>
#include <vector>

namespace llull {
namespace query {

namespace {

std::atomic<bool> g_patch_integrator{true};
std::atomic<int> g_order_override{0};
std::atomic<double> g_agree_override{0.0};
std::atomic<double> g_domain_gap{0.0};
std::atomic<int> g_refusal{0};  // why the last face was left to BRepGProp: 1 boundary, 2 integrate, 3 no convergence, 4 parameter domain

// An eligible face has at least this many knot cells: below it BRepGProp is as fast and the small faces stay on the rule every golden value was made with.
constexpr size_t kMinCells = 64;
constexpr int kMaxDegree = 12;
// BRepGProp's rule is tight on a surface of high degree (it agreed to 1e-12 on the vertex fans, degree 7) and loose on a low one (1.4e-6 on a bicubic wave): the strips take only faces of degree 6 or more, where the two agree
constexpr int kMinDegree = 6;
constexpr double kPi = 3.14159265358979323846;
constexpr int kMaxOrder = 61;
constexpr int kOrders[] = {4, 5, 6, 8, 12, 16, 24, 32, 48};
constexpr double kAgree = 1e-11;
// the parameter-domain area of the strips (order 32) against Green's theorem along the boundary: a dropped or mispaired piece is far above this
constexpr double kDomain = 1e-11;

struct Sums {
  double m0 = 0, m1[3] = {0, 0, 0}, m2[6] = {0, 0, 0, 0, 0, 0};  // m2: xx yy zz xy xz yz
};

// `s` is the point relative to the reference point of the shape: the cones of a closed shell are valid from any apex, and the moments about a point near the shape do not cancel.
inline void accumulate(Sums &sums, bool volume, double weight, const double *s, const double *su, const double *sv) {
  const double nx = su[1] * sv[2] - su[2] * sv[1], ny = su[2] * sv[0] - su[0] * sv[2], nz = su[0] * sv[1] - su[1] * sv[0];
  const double f = weight * (volume ? s[0] * nx + s[1] * ny + s[2] * nz : std::sqrt(nx * nx + ny * ny + nz * nz));
  sums.m0 += f;
  for (int k = 0; k < 3; ++k) sums.m1[k] += f * s[k];
  sums.m2[0] += f * s[0] * s[0], sums.m2[1] += f * s[1] * s[1], sums.m2[2] += f * s[2] * s[2];
  sums.m2[3] += f * s[0] * s[1], sums.m2[4] += f * s[0] * s[2], sums.m2[5] += f * s[1] * s[2];
}

struct Integrator {
  const Surf &surf;
  bool volume;
  Rule rule_u, rule_v;
  Sums sums;
  double u_eps = 0;  // the tolerance of a coincidence in u
  Row row;
  std::vector<std::vector<VNode>> cached;  // per v cell: the basis at the nodes of the whole cell
  double ref[3] = {0, 0, 0};
  bool width_only = false;  // only the area of the parameter domain (no surface point)
  double uv_area = 0;

  const std::vector<VNode> &cell_nodes(int cell) {
    std::vector<VNode> &nodes = cached[cell];
    if (nodes.empty()) {
      const double a = surf.v.knots[cell], b = surf.v.knots[cell + 1];
      nodes.resize(rule_v.x.size());
      for (size_t k = 0; k < nodes.size(); ++k) basis_and_derivative(surf.v, surf.v.last[cell], 0.5 * (a + b) + 0.5 * (b - a) * rule_v.x[k], nodes[k].n, nodes[k].d);
    }
    return nodes;
  }

  // The v interval [low, high] inside cell `cell`, at the row set for one u node of weight `weight_u`.
  void along_v(int cell, double low, double high, bool whole, double weight_u) {
    const double half = 0.5 * (high - low), mid = 0.5 * (high + low);
    const int span = surf.v.last[cell];
    const std::vector<VNode> *nodes = whole ? &cell_nodes(cell) : nullptr;
    VNode fresh;
    double s[3], su[3], sv[3];
    for (size_t k = 0; k < rule_v.x.size(); ++k) {
      if (!whole) basis_and_derivative(surf.v, span, mid + half * rule_v.x[k], fresh.n, fresh.d);
      const VNode &basis = whole ? (*nodes)[k] : fresh;
      evaluate(surf, row, span, basis, s, su, sv);
      for (int c = 0; c < 3; ++c) s[c] -= ref[c];
      accumulate(sums, volume, weight_u * half * rule_v.w[k], s, su, sv);
    }
  }

  // The strip [a, b] of u between the paired boundary pieces `bounds` (lower, upper, ...), none of which crosses a knot line inside it.
  bool strip(double a, double b, const std::vector<const Piece *> &bounds) {
    const double mid = 0.5 * (a + b), half = 0.5 * (b - a);
    const int u_cell = surf.u.cell_of(mid), u_span = surf.u.last[u_cell];
    bool ok = true;
    struct Pair {
      int low_cell, high_cell;
    };
    std::vector<Pair> pairs;
    for (size_t k = 0; k + 1 < bounds.size(); k += 2) {
      const int low_cell = surf.v.cell_of(v_at(*bounds[k], mid, ok)), high_cell = surf.v.cell_below(v_at(*bounds[k + 1], mid, ok));
      pairs.push_back({low_cell, std::max(low_cell, high_cell)});
    }
    if (!ok) return false;
    // a strip that ends where a boundary piece turns (vertical tangent) is integrated in s with u = a + (b - a) s^2 (or the mirror, or both ends by a cosine): the width is then smooth in s
    bool left = false, right = false;
    for (const Piece *piece : bounds) {
      left = left || (piece->steep0 && std::fabs(piece->u0 - a) <= u_eps);
      right = right || (piece->steep1 && std::fabs(piece->u1 - b) <= u_eps);
    }
    for (size_t i = 0; i < rule_u.x.size(); ++i) {
      const double s = 0.5 * (1 + rule_u.x[i]), ds = 0.5 * rule_u.w[i], span = b - a;
      double x = mid + half * rule_u.x[i], weight_u = half * rule_u.w[i];
      if (left && right) x = a + span * 0.5 * (1 - std::cos(kPi * s)), weight_u = ds * span * 0.5 * kPi * std::sin(kPi * s);
      else if (left) x = a + span * s * s, weight_u = ds * 2 * span * s;
      else if (right) x = b - span * s * s, weight_u = ds * 2 * span * s;
      if (!width_only) combine_row(surf, u_span, x, row);
      for (size_t k = 0; k < pairs.size(); ++k) {
        const int cl = pairs[k].low_cell, ch = pairs[k].high_cell;
        const double raw_low = v_at(*bounds[2 * k], x, ok), raw_high = v_at(*bounds[2 * k + 1], x, ok);
        if (!ok) return false;
        if (width_only) {
          uv_area += weight_u * (raw_high - raw_low);
          continue;
        }
        const double low = std::max(raw_low, surf.v.knots[cl]), high = std::min(raw_high, surf.v.knots[ch + 1]);
        for (int c = cl; c <= ch; ++c) {
          const double from = c == cl ? low : surf.v.knots[c], to = c == ch ? high : surf.v.knots[c + 1];
          if (to > from) along_v(c, from, to, c > cl && c < ch, weight_u);
        }
      }
    }
    return true;
  }
};

// The strips of the face: its u axis is cut at the knots, at every end of a boundary piece, and (per strip) where a boundary piece crosses a v knot, so the integrand of each strip is smooth.
bool integrate(Integrator &integrator, const std::vector<Piece> &pieces) {
  const Surf &surf = integrator.surf;
  double u_low = 1e300, u_high = -1e300;
  for (const Piece &piece : pieces) u_low = std::min(u_low, piece.u0), u_high = std::max(u_high, piece.u1);
  const double width = u_high - u_low, eps = 1e-13 * width;
  if (!(width > 0)) return false;
  integrator.u_eps = 1e-9 * width;
  std::vector<double> breaks;
  for (const Piece &piece : pieces)
    if (piece.u1 - piece.u0 > eps) breaks.push_back(piece.u0), breaks.push_back(piece.u1);
  for (double knot : surf.u.knots)
    if (knot > u_low + eps && knot < u_high - eps) breaks.push_back(knot);
  std::sort(breaks.begin(), breaks.end());
  for (size_t i = 0; i + 1 < breaks.size(); ++i) {
    const double a = breaks[i], b = breaks[i + 1];
    if (!(b - a > eps)) continue;
    bool ok = true;
    std::vector<const Piece *> active;
    for (const Piece &piece : pieces)
      if (piece.u1 - piece.u0 > eps && piece.u0 <= a + eps && piece.u1 >= b - eps) active.push_back(&piece);
    if (active.size() % 2 != 0) return false;
    const double mid = 0.5 * (a + b);
    std::vector<std::pair<double, const Piece *>> keyed;
    for (const Piece *piece : active) keyed.push_back({v_at(*piece, mid, ok), piece});
    if (!ok) return false;
    std::sort(keyed.begin(), keyed.end(), [](const auto &x, const auto &y) { return x.first < y.first; });
    for (size_t k = 0; k < keyed.size(); ++k) active[k] = keyed[k].second;
    std::vector<double> cuts{a, b};
    for (const Piece *piece : active) {
      const double from = v_at(*piece, a, ok), to = v_at(*piece, b, ok);
      const double low = std::min(from, to), high = std::max(from, to);
      for (auto knot = std::upper_bound(surf.v.knots.begin(), surf.v.knots.end(), low); knot != surf.v.knots.end() && *knot < high; ++knot) {
        const double at = u_at(*piece, *knot, ok);
        if (at > a + eps && at < b - eps) cuts.push_back(at);
      }
    }
    if (!ok) return false;
    std::sort(cuts.begin(), cuts.end());
    for (size_t k = 0; k + 1 < cuts.size(); ++k)
      if (cuts[k + 1] - cuts[k] > eps && !integrator.strip(cuts[k], cuts[k + 1], active)) return false;
  }
  return true;
}

// The pieces of the boundary of the face, the face taken forward so that its edges bound the parameter domain. False when an edge cannot be read (no pcurve range, a piece that is not monotone).
bool boundary_of(const TopoDS_Face &face, std::vector<Piece> &pieces) {
  const TopoDS_Face forward = TopoDS::Face(face.Oriented(TopAbs_FORWARD));
  for (TopExp_Explorer edges(forward, TopAbs_EDGE); edges.More(); edges.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(edges.Current());
    if (edge.Orientation() == TopAbs_INTERNAL || edge.Orientation() == TopAbs_EXTERNAL) continue;
    const auto curve = std::make_shared<BRepAdaptor_Curve2d>(edge, forward);
    if (!(curve->FirstParameter() < curve->LastParameter())) return false;
    if (!add_pieces(curve, edge.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0, pieces)) return false;
  }
  return !pieces.empty();
}

bool eligible(const TopoDS_Face &face, Surf &surf) {
  if (!g_patch_integrator.load()) return false;
  if (!face.Location().IsIdentity() && face.Location().Transformation().IsNegative()) return false;
  const Handle(Geom_Surface) any = BRep_Tool::Surface(face);
  if (any.IsNull()) return false;
  const Handle(Geom_BSplineSurface) spline = Handle(Geom_BSplineSurface)::DownCast(any);
  if (spline.IsNull() || spline->IsURational() || spline->IsVRational() || spline->IsUPeriodic() || spline->IsVPeriodic()) return false;
  if (static_cast<size_t>(spline->NbUKnots() - 1) * static_cast<size_t>(spline->NbVKnots() - 1) < kMinCells) return false;
  if (spline->UDegree() < kMinDegree || spline->VDegree() < kMinDegree || spline->UDegree() > kMaxDegree || spline->VDegree() > kMaxDegree) return false;
  return load_surface(spline, surf);
}

// The largest disagreement of two sets of moments, each term scaled by what it measures (mass, mass x reach, mass x reach^2) and a floor of rounding.
double disagreement(const Sums &x, const Sums &y, double reach, bool volume) {
  const double unit = std::fabs(x.m0) + 1e-15 * (volume ? reach * reach * reach : reach * reach);
  double worst = std::fabs(x.m0 - y.m0) / unit;
  for (int k = 0; k < 3; ++k) worst = std::max(worst, std::fabs(x.m1[k] - y.m1[k]) / (unit * reach));
  for (int k = 0; k < 6; ++k) worst = std::max(worst, std::fabs(x.m2[k] - y.m2[k]) / (unit * reach * reach));
  return worst;
}

// The parameter-domain area two ways (strips at order 32, Green along the boundary): a piece the strips dropped or paired wrongly shows as a mismatch.
bool domain_is_consistent(const Surf &surf, const std::vector<Piece> &pieces) {
  bool curved = false;
  for (const Piece &piece : pieces) curved = curved || !piece.line;
  // straight pieces make the width linear in u: a few nodes are exact
  Integrator probe{surf, false, gauss_rule(curved ? 16 : 4), gauss_rule(1), Sums(), 0.0, Row(), {}};
  probe.width_only = true;
  if (!integrate(probe, pieces)) return false;
  double u_low = 1e300, u_high = -1e300, v_low = 1e300, v_high = -1e300;
  for (const Piece &piece : pieces) {
    u_low = std::min(u_low, piece.u0), u_high = std::max(u_high, piece.u1);
    v_low = std::min({v_low, piece.v0, piece.v1}), v_high = std::max({v_high, piece.v0, piece.v1});
  }
  const double green = std::fabs(domain_area(pieces));
  const double scale = std::max(green, 1e-3 * (u_high - u_low) * (v_high - v_low));
  g_domain_gap = std::fabs(green - probe.uv_area) / scale;
  return g_domain_gap.load() <= kDomain;
}

// Adds the weighted moments of one face, about `ref`, to `total`; false when the face cannot be integrated by strips (the caller leaves it to BRepGProp).
bool face_sums(const TopoDS_Face &face, bool volume, const Surf &surf, const double *ref, Sums &total) {
  std::vector<Piece> pieces;
  if (!boundary_of(face, pieces)) return g_refusal = 1, false;
  // Orders 4, 6, 8, 12, ... are run in turn until three successive ones agree pairwise to kAgree on every moment (Gauss errors fall faster than geometrically, so the error of the highest is then far below the
  // differences; two orders alone can agree by chance). A smooth face such as a vertex fan agrees from 4 (1e-13 measured, 13.48); a rough or trimmed one climbs; a face that has not agreed by the last order is left to BRepGProp.
  double reach = 0;
  for (size_t i = 0; i + 2 < surf.poles.size(); i += 3)
    for (int k = 0; k < 3; ++k) reach = std::max(reach, std::fabs(surf.poles[i + k] - ref[k]));
  const auto run = [&](int order, Sums &out) {
    if (order > kMaxOrder) return false;
    Integrator integrator{surf, volume, gauss_rule(order), gauss_rule(order), Sums(), 0.0, Row(), {}};
    for (int k = 0; k < 3; ++k) integrator.ref[k] = ref[k];
    integrator.cached.resize(surf.v.knots.size() - 1);
    if (!integrate(integrator, pieces)) return false;
    out = integrator.sums;
    return true;
  };
  Sums sums;
  const int forced = g_order_override.load();
  if (forced > 0) {
    if (!run(forced, sums)) return false;
  } else {
    if (g_agree_override.load() < 0) return g_refusal = 3, false;  // the test hook: no face converges
    const double agree = g_agree_override.load() > 0 ? g_agree_override.load() : kAgree;
    Sums lower;
    if (!run(kOrders[0], lower)) return g_refusal = 2, false;
    double previous_gap = 1e300;
    bool converged = false;
    for (size_t k = 1; k < sizeof(kOrders) / sizeof(kOrders[0]) && !converged; ++k) {
      if (!run(kOrders[k], sums)) return g_refusal = 2, false;
      const double gap = disagreement(sums, lower, reach, volume);
      converged = gap <= agree && previous_gap <= agree;
      previous_gap = gap;
      lower = sums;
    }
    if (!converged) return g_refusal = 3, false;
  }
  if (!domain_is_consistent(surf, pieces)) return g_refusal = 4, false;
  const double sign = volume && face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
  const double scale[3] = {volume ? 1.0 / 3 : 1.0, volume ? 1.0 / 4 : 1.0, volume ? 1.0 / 5 : 1.0};
  total.m0 += sign * scale[0] * sums.m0;
  for (int k = 0; k < 3; ++k) total.m1[k] += sign * scale[1] * sums.m1[k];
  for (int k = 0; k < 6; ++k) total.m2[k] += sign * scale[2] * sums.m2[k];
  return true;
}

// The same, any failure of OCCT or of the standard library answering "not taken".
bool face_sums_guarded(const TopoDS_Face &face, bool volume, const double *ref, Sums &total) {
  try {
    Surf surf;
    return eligible(face, surf) && face_sums(face, volume, surf, ref, total);
  } catch (const Standard_Failure &) {
    return false;
  } catch (const std::exception &) {
    return false;
  }
}

// The properties of a mass, a centre relative to the reference point `ref` and an inertia matrix about it, with `ref` as the reference point of the result.
class MomentProps : public GProp_GProps {
 public:
  MomentProps(double mass, const gp_XYZ &centre_from_ref, const gp_Mat &about_ref, const gp_Pnt &ref) : GProp_GProps(ref) {
    dim = mass;
    g = gp_Pnt(centre_from_ref);  // GProp_GProps keeps the centre relative to its reference point (CentreOfMass adds `loc`)
    inertia = about_ref;
  }
};

// The matrix of inertia about the reference point from the second moments xx yy zz xy xz yz.
gp_Mat inertia_of(const double *q) { return gp_Mat(q[1] + q[2], -q[3], -q[4], -q[3], q[0] + q[2], -q[5], -q[4], -q[5], q[0] + q[1]); }

bool fast_properties(const TopoDS_Shape &shape, GProp_GProps &out, bool volume) {
  if (volume && !all_shells_closed(shape)) return false;
  // the reference point: the centre of the poles of the first eligible face (near the shape, whatever the shape's place)
  double ref[3] = {0, 0, 0};
  bool any = false;
  for (TopExp_Explorer faces(shape, TopAbs_FACE); faces.More() && !any; faces.Next()) {
    Surf surf;
    if (!eligible(TopoDS::Face(faces.Current()), surf)) continue;
    double low[3] = {1e300, 1e300, 1e300}, high[3] = {-1e300, -1e300, -1e300};
    for (size_t i = 0; i + 2 < surf.poles.size(); i += 3)
      for (int k = 0; k < 3; ++k) low[k] = std::min(low[k], surf.poles[i + k]), high[k] = std::max(high[k], surf.poles[i + k]);
    for (int k = 0; k < 3; ++k) ref[k] = 0.5 * (low[k] + high[k]);
    any = true;
  }
  if (!any) return false;
  BRep_Builder builder;
  TopoDS_Compound rest;
  builder.MakeCompound(rest);
  Sums total;
  int taken = 0, left = 0;
  for (TopExp_Explorer faces(shape, TopAbs_FACE); faces.More(); faces.Next()) {
    const TopoDS_Face face = TopoDS::Face(faces.Current());
    if (face_sums_guarded(face, volume, ref, total)) {
      ++taken;
    } else {
      builder.Add(rest, face);
      ++left;
    }
  }
  if (taken == 0) return false;
  const gp_Pnt centre(ref[0], ref[1], ref[2]);
  GProp_GProps result = MomentProps(total.m0, std::fabs(total.m0) > 0 ? gp_XYZ(total.m1[0], total.m1[1], total.m1[2]) / total.m0 : gp_XYZ(0, 0, 0), inertia_of(total.m2), centre);
  if (left > 0) {
    if (volume) {
      // BRepGProp::VolumeProperties of an open set of faces does not take the origin as apex (measured): face by face with the cones from `ref`, the apex of the faces taken
      for (TopExp_Explorer faces(rest, TopAbs_FACE); faces.More(); faces.Next()) {
        const TopoDS_Face face = TopoDS::Face(faces.Current());
        BRepGProp_Face surface;
        BRepGProp_Domain domain(face);
        surface.Load(face);
        result.Add(BRepGProp_Vinert(surface, domain, centre));
      }
    } else {
      GProp_GProps others;
      BRepGProp::SurfaceProperties(rest, others, Standard_False, Standard_False);
      result.Add(others);
    }
  }
  out = result;
  return true;
}

}  // namespace

void set_patch_integrator(bool on) { g_patch_integrator.store(on); }

void set_patch_order(int order) { g_order_override.store(order); }

void set_patch_agreement(double tolerance) { g_agree_override.store(tolerance); }

int last_patch_refusal() { return g_refusal.load(); }

double last_domain_gap() { return g_domain_gap.load(); }

bool fast_surface_properties(const TopoDS_Shape &shape, GProp_GProps &out) { return fast_properties(shape, out, false); }

bool fast_volume_properties(const TopoDS_Shape &shape, GProp_GProps &out) { return fast_properties(shape, out, true); }

void volume_properties(const TopoDS_Shape &shape, GProp_GProps &out) {
  if (!fast_volume_properties(shape, out)) BRepGProp::VolumeProperties(shape, out);
}

void surface_properties(const TopoDS_Shape &shape, GProp_GProps &out) {
  if (!fast_surface_properties(shape, out)) BRepGProp::SurfaceProperties(shape, out);
}

int eligible_patch_faces(const TopoDS_Shape &shape) {
  int count = 0;
  for (TopExp_Explorer faces(shape, TopAbs_FACE); faces.More(); faces.Next()) {
    Surf surf;
    if (eligible(TopoDS::Face(faces.Current()), surf)) ++count;
  }
  return count;
}

}  // namespace query
}  // namespace llull

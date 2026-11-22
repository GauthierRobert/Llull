#include "llull-kernel-occt/cpp/mass_patch.hxx"

#include "llull-kernel-occt/cpp/mass_spans.hxx"
#include "llull-kernel-occt/cpp/mass_patch_basis.hxx"

#include <BRepAdaptor_Curve2d.hxx>
#include <BRepGProp.hxx>
#include <BRep_Builder.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Mat.hxx>
#include <gp_Pnt.hxx>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

namespace llull {
namespace query {

namespace {

std::atomic<bool> g_patch_integrator{true};
std::atomic<int> g_order_override{0};

// An eligible face has at least this many knot cells: below it BRepGProp is as fast and the small faces stay on the rule every golden value was made with.
constexpr size_t kMinCells = 64;
constexpr int kMaxDegree = 12;
// BRepGProp's rule is tight on a surface of high degree (it agreed to 1e-12 on the vertex fans, degree 7) and loose on a low one (1.4e-6 on a bicubic wave): the strips take only faces of degree 6 or more, where the two agree
constexpr int kMinDegree = 6;
constexpr double kPi = 3.14159265358979323846;
constexpr int kMaxOrder = 61;
constexpr int kOrders[] = {4, 6, 10, 16, 24, 32, 48};
constexpr double kAgree = 1e-12;

// A boundary piece of the face in (u, v), monotone in both: a straight segment (closed form) or a part of a curve (inverted by a safeguarded Newton). `t0` is the end with the lower u.
struct Piece {
  bool line = false;
  double u0 = 0, v0 = 0, u1 = 0, v1 = 0;
  std::shared_ptr<BRepAdaptor_Curve2d> curve;
  double t0 = 0, t1 = 0;
  // the tangent is vertical (du = 0) at the lower-u / upper-u end: the width of a strip that ends there goes as a square root of u, which Gauss points do not resolve (see strip)
  bool steep0 = false, steep1 = false;
};

// The parameter t of `curve` in [ta, tb] at which its coordinate `axis` (0 u, 1 v) equals `target`, a coordinate monotone on the interval.
bool solve(const BRepAdaptor_Curve2d &curve, int axis, double ta, double tb, double target, double &t) {
  const double scale = std::max(1.0, std::fabs(target));
  gp_Pnt2d point;
  gp_Vec2d slope;
  curve.D1(ta, point, slope);
  const double ga = point.Coord(axis + 1) - target;
  curve.D1(tb, point, slope);
  const double gb = point.Coord(axis + 1) - target;
  if (std::fabs(ga) <= 1e-15 * scale) return t = ta, true;
  if (std::fabs(gb) <= 1e-15 * scale) return t = tb, true;
  if (ga * gb > 0) return false;
  double lo = ta, hi = tb;
  t = ta + (tb - ta) * ga / (ga - gb);
  for (int i = 0; i < 80; ++i) {
    curve.D1(t, point, slope);
    const double g = point.Coord(axis + 1) - target;
    if (std::fabs(g) <= 1e-15 * scale) return true;
    if ((g < 0) == (ga < 0)) lo = t;
    else hi = t;
    const double d = slope.Coord(axis + 1);
    double next = d != 0 ? t - g / d : 0.5 * (lo + hi);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (std::fabs(next - t) <= 1e-16 * (1 + std::fabs(t))) {
      t = next;
      break;
    }
    t = next;
  }
  curve.D1(t, point, slope);
  return std::fabs(point.Coord(axis + 1) - target) <= 1e-12 * scale;
}

double v_at(const Piece &piece, double u, bool &ok) {
  if (piece.line) return piece.v0 + (u - piece.u0) * (piece.v1 - piece.v0) / (piece.u1 - piece.u0);
  double t = 0;
  if (!solve(*piece.curve, 0, piece.t0, piece.t1, u, t)) return ok = false, 0.0;
  return piece.curve->Value(t).Y();
}

double u_at(const Piece &piece, double v, bool &ok) {
  if (piece.line) return piece.u0 + (v - piece.v0) * (piece.u1 - piece.u0) / (piece.v1 - piece.v0);
  double t = 0;
  if (!solve(*piece.curve, 1, piece.t0, piece.t1, v, t)) return ok = false, 0.0;
  return piece.curve->Value(t).X();
}

Piece make_piece(const std::shared_ptr<BRepAdaptor_Curve2d> &curve, bool line, double ta, double tb) {
  Piece piece;
  piece.line = line;
  piece.curve = curve;
  const gp_Pnt2d a = curve->Value(ta), b = curve->Value(tb);
  const bool forward = a.X() <= b.X();
  piece.t0 = forward ? ta : tb;
  piece.t1 = forward ? tb : ta;
  const gp_Pnt2d low = forward ? a : b, high = forward ? b : a;
  piece.u0 = low.X(), piece.v0 = low.Y(), piece.u1 = high.X(), piece.v1 = high.Y();
  if (!line) {
    gp_Pnt2d point;
    gp_Vec2d slope;
    curve->D1(piece.t0, point, slope);
    piece.steep0 = std::fabs(slope.X()) <= 1e-6 * std::fabs(slope.Y());
    curve->D1(piece.t1, point, slope);
    piece.steep1 = std::fabs(slope.X()) <= 1e-6 * std::fabs(slope.Y());
  }
  return piece;
}

// The parameter in (ta, tb) where the derivative of coordinate `axis` changes sign, by bisection on the sign.
double derivative_root(const BRepAdaptor_Curve2d &curve, int axis, double ta, double tb) {
  gp_Pnt2d point;
  gp_Vec2d slope;
  curve.D1(ta, point, slope);
  const bool positive = slope.Coord(axis + 1) > 0;
  for (int i = 0; i < 60; ++i) {
    const double mid = 0.5 * (ta + tb);
    curve.D1(mid, point, slope);
    if ((slope.Coord(axis + 1) > 0) == positive) ta = mid;
    else tb = mid;
  }
  return 0.5 * (ta + tb);
}

// The edge cut at the extrema of u and of v (sampled at 48 points, the sign changes bisected): each piece is monotone in both.
void add_pieces(const std::shared_ptr<BRepAdaptor_Curve2d> &curve, std::vector<Piece> &out) {
  const double first = curve->FirstParameter(), last = curve->LastParameter();
  if (curve->GetType() == GeomAbs_Line) {
    out.push_back(make_piece(curve, true, first, last));
    return;
  }
  constexpr int kSamples = 48;
  std::vector<double> cuts{first};
  gp_Pnt2d point;
  gp_Vec2d slope, before;
  curve->D1(first, point, before);
  double previous = first;
  for (int i = 1; i <= kSamples; ++i) {
    const double t = first + (last - first) * i / kSamples;
    curve->D1(t, point, slope);
    for (int axis = 0; axis < 2; ++axis) {
      const double a = before.Coord(axis + 1), b = slope.Coord(axis + 1);
      if ((a > 0 && b < 0) || (a < 0 && b > 0)) cuts.push_back(derivative_root(*curve, axis, previous, t));
    }
    before = slope;
    previous = t;
  }
  cuts.push_back(last);
  std::sort(cuts.begin(), cuts.end());
  for (size_t i = 0; i + 1 < cuts.size(); ++i)
    if (cuts[i + 1] > cuts[i]) out.push_back(make_piece(curve, false, cuts[i], cuts[i + 1]));
}

struct Sums {
  double m0 = 0, m1[3] = {0, 0, 0}, m2[6] = {0, 0, 0, 0, 0, 0};  // m2: xx yy zz xy xz yz
};

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
      combine_row(surf, u_span, x, row);
      for (size_t k = 0; k < pairs.size(); ++k) {
        const int cl = pairs[k].low_cell, ch = pairs[k].high_cell;
        const double low = std::max(v_at(*bounds[2 * k], x, ok), surf.v.knots[cl]), high = std::min(v_at(*bounds[2 * k + 1], x, ok), surf.v.knots[ch + 1]);
        if (!ok) return false;
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

// The pieces of the boundary of the face, the face taken forward so that its edges bound the parameter domain.
bool boundary_of(const TopoDS_Face &face, std::vector<Piece> &pieces) {
  const TopoDS_Face forward = TopoDS::Face(face.Oriented(TopAbs_FORWARD));
  for (TopExp_Explorer edges(forward, TopAbs_EDGE); edges.More(); edges.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(edges.Current());
    if (edge.Orientation() == TopAbs_INTERNAL || edge.Orientation() == TopAbs_EXTERNAL) continue;
    const auto curve = std::make_shared<BRepAdaptor_Curve2d>(edge, forward);
    if (curve->FirstParameter() >= curve->LastParameter()) continue;
    add_pieces(curve, pieces);
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

// Adds the weighted moments of one face to `total`; false when the face cannot be integrated by strips.
bool face_sums(const TopoDS_Face &face, bool volume, Sums &total) {
  Surf surf;
  if (!eligible(face, surf)) return false;
  std::vector<Piece> pieces;
  if (!boundary_of(face, pieces)) return false;
  // Orders 4, 6, 10, 16, ... are run in turn until two successive ones agree to kAgree on every moment (the error of the higher one is then far below the difference: Gauss errors fall faster than
  // geometrically). A smooth face such as a vertex fan agrees at 4 and 6 (1e-13 measured, 13.48); a rough or trimmed one climbs; a face that does not agree by the last order is left to BRepGProp.
  const auto run = [&](int order, Sums &out) {
    if (order > kMaxOrder) return false;
    Integrator integrator{surf, volume, gauss_rule(order), gauss_rule(order), Sums(), 0.0, Row(), {}};
    integrator.cached.resize(surf.v.knots.size() - 1);
    if (!integrate(integrator, pieces)) return false;
    out = integrator.sums;
    return true;
  };
  double reach = 0;
  for (double pole : surf.poles) reach = std::max(reach, std::fabs(pole));
  const auto agree = [&](const Sums &x, const Sums &y) {
    const double tolerance = kAgree * std::fabs(x.m0) + 1e-15 * (volume ? reach * reach * reach : reach * reach);
    bool same = std::fabs(x.m0 - y.m0) <= tolerance;
    for (int k = 0; k < 3; ++k) same = same && std::fabs(x.m1[k] - y.m1[k]) <= tolerance * reach;
    for (int k = 0; k < 6; ++k) same = same && std::fabs(x.m2[k] - y.m2[k]) <= tolerance * reach * reach;
    return same;
  };
  Sums sums;
  const int forced = g_order_override.load();
  if (forced > 0) {
    if (!run(forced, sums)) return false;
  } else {
    Sums lower;
    if (!run(kOrders[0], lower)) return false;
    bool converged = false;
    for (size_t k = 1; k < sizeof(kOrders) / sizeof(kOrders[0]) && !converged; ++k) {
      if (!run(kOrders[k], sums)) return false;
      converged = agree(sums, lower);
      lower = sums;
    }
    if (!converged) return false;
  }
  const double sign = volume && face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
  const double scale[3] = {volume ? 1.0 / 3 : 1.0, volume ? 1.0 / 4 : 1.0, volume ? 1.0 / 5 : 1.0};
  total.m0 += sign * scale[0] * sums.m0;
  for (int k = 0; k < 3; ++k) total.m1[k] += sign * scale[1] * sums.m1[k];
  for (int k = 0; k < 6; ++k) total.m2[k] += sign * scale[2] * sums.m2[k];
  return true;
}

// The properties of a set of moments, with the origin as reference point.
class MomentProps : public GProp_GProps {
 public:
  explicit MomentProps(const Sums &sums) {
    dim = sums.m0;
    g = std::fabs(sums.m0) > 0 ? gp_Pnt(sums.m1[0] / sums.m0, sums.m1[1] / sums.m0, sums.m1[2] / sums.m0) : gp_Pnt(0, 0, 0);
    const double *q = sums.m2;
    inertia = gp_Mat(q[1] + q[2], -q[3], -q[4], -q[3], q[0] + q[2], -q[5], -q[4], -q[5], q[0] + q[1]);
  }
};

bool fast_properties(const TopoDS_Shape &shape, GProp_GProps &out, bool volume) {
  if (volume && !all_shells_closed(shape)) return false;
  BRep_Builder builder;
  TopoDS_Compound rest;
  builder.MakeCompound(rest);
  Sums total;
  int taken = 0, left = 0;
  for (TopExp_Explorer faces(shape, TopAbs_FACE); faces.More(); faces.Next()) {
    const TopoDS_Face face = TopoDS::Face(faces.Current());
    if (face_sums(face, volume, total)) {
      ++taken;
    } else {
      builder.Add(rest, face);
      ++left;
    }
  }
  if (taken == 0) return false;
  out = GProp_GProps();
  out.Add(MomentProps(total));
  if (left > 0) {
    GProp_GProps others;
    if (volume) BRepGProp::VolumeProperties(rest, others, Standard_False, Standard_False, Standard_False);
    else BRepGProp::SurfaceProperties(rest, others, Standard_False, Standard_False);
    out.Add(others);
  }
  return true;
}

}  // namespace

void set_patch_integrator(bool on) { g_patch_integrator.store(on); }

void set_patch_order(int order) { g_order_override.store(order); }

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

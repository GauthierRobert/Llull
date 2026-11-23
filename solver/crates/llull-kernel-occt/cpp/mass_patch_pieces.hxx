// The boundary of a face in (u, v) as pieces monotone in both coordinates (mass_patch.cxx): cut at the extrema of u and v and at the ends of the C2 intervals of each pcurve, each piece checked to be monotone, and the area
// of the parameter domain by Green's theorem along the pieces (the cross-check of the strips).
#pragma once

#include <BRepAdaptor_Curve2d.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec2d.hxx>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "llull-kernel-occt/cpp/mass_patch_basis.hxx"

namespace llull {
namespace query {

// A boundary piece of the face in (u, v), monotone in both: a straight segment (closed form) or a part of a curve (inverted by a safeguarded Newton). `t0` is the end with the lower u.
struct Piece {
  bool line = false;
  double u0 = 0, v0 = 0, u1 = 0, v1 = 0;
  std::shared_ptr<BRepAdaptor_Curve2d> curve;
  double t0 = 0, t1 = 0;
  // the tangent is vertical (du = 0) at the lower-u / upper-u end: the width of a strip that ends there goes as a square root of u, which Gauss points do not resolve (see strip)
  bool steep0 = false, steep1 = false;
  // the parameter range of the piece on its edge (ga < gb) and the direction the face's boundary runs along the edge (+1 with increasing parameter, -1 against it)
  double ga = 0, gb = 0, direction = 1;
};

// The parameter t of `curve` in [ta, tb] at which its coordinate `axis` (0 u, 1 v) equals `target`, a coordinate monotone on the interval.
inline bool solve(const BRepAdaptor_Curve2d &curve, int axis, double ta, double tb, double target, double &t) {
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

inline double v_at(const Piece &piece, double u, bool &ok) {
  if (piece.line) return piece.v0 + (u - piece.u0) * (piece.v1 - piece.v0) / (piece.u1 - piece.u0);
  double t = 0;
  if (!solve(*piece.curve, 0, piece.t0, piece.t1, u, t)) return ok = false, 0.0;
  return piece.curve->Value(t).Y();
}

inline double u_at(const Piece &piece, double v, bool &ok) {
  if (piece.line) return piece.u0 + (v - piece.v0) * (piece.u1 - piece.u0) / (piece.v1 - piece.v0);
  double t = 0;
  if (!solve(*piece.curve, 1, piece.t0, piece.t1, v, t)) return ok = false, 0.0;
  return piece.curve->Value(t).X();
}

inline Piece make_piece(const std::shared_ptr<BRepAdaptor_Curve2d> &curve, bool line, double ta, double tb, double direction) {
  Piece piece;
  piece.line = line;
  piece.curve = curve;
  piece.ga = ta, piece.gb = tb, piece.direction = direction;
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
inline double derivative_root(const BRepAdaptor_Curve2d &curve, int axis, double ta, double tb) {
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

// Candidate cuts of one interval [ta, tb] of a curve: a sample where a derivative is zero, and the root between two samples whose last non-zero derivatives differ in sign.
inline void extremum_cuts(const BRepAdaptor_Curve2d &curve, double ta, double tb, int kSamples, std::vector<double> &cuts) {
  gp_Pnt2d point;
  gp_Vec2d slope;
  for (int axis = 0; axis < 2; ++axis) {
    int last_sign = 0;
    double last_t = ta;
    for (int i = 0; i <= kSamples; ++i) {
      const double t = ta + (tb - ta) * i / kSamples;
      curve.D1(t, point, slope);
      const double d = slope.Coord(axis + 1), speed = std::hypot(slope.X(), slope.Y());
      const int sign = std::fabs(d) <= 1e-12 * speed ? 0 : (d > 0 ? 1 : -1);
      if (sign == 0) {
        if (i > 0 && i < kSamples) cuts.push_back(t);
        continue;
      }
      if (last_sign != 0 && sign != last_sign) cuts.push_back(derivative_root(curve, axis, last_t, t));
      last_sign = sign, last_t = t;
    }
  }
}

// Whether the piece is monotone in u and in v at `kSamples` + 1 samples (a coordinate that moves back by more than 1e-10 of its size is not).
inline bool is_monotone(const Piece &piece, int kSamples) {
  for (int axis = 0; axis < 2; ++axis) {
    std::vector<double> values;
    for (int i = 0; i <= kSamples; ++i) values.push_back(piece.curve->Value(piece.ga + (piece.gb - piece.ga) * i / kSamples).Coord(axis + 1));
    const double net = values.back() - values.front(), size = 1 + std::fabs(values.front());
    for (size_t i = 0; i + 1 < values.size(); ++i) {
      const double step = values[i + 1] - values[i];
      if (net != 0 && step * (net > 0 ? 1.0 : -1.0) < -1e-10 * size) return false;
      if (net == 0 && std::fabs(values[i + 1] - values.front()) > 1e-10 * size) return false;
    }
  }
  return true;
}

// The edge cut at the ends of its C2 intervals and at the extrema of u and of v: each piece is monotone in both (checked: false when one is not). `direction` is the sense the boundary runs along the edge.
inline bool add_pieces(const std::shared_ptr<BRepAdaptor_Curve2d> &curve, double direction, std::vector<Piece> &out) {
  const double first = curve->FirstParameter(), last = curve->LastParameter();
  if (curve->GetType() == GeomAbs_Line) {
    out.push_back(make_piece(curve, true, first, last, direction));
    return true;
  }
  const int intervals = curve->NbIntervals(GeomAbs_C2);
  TColStd_Array1OfReal ends(1, intervals + 1);
  curve->Intervals(ends, GeomAbs_C2);
  // samples: 16 per interval, and 6 per knot span of a spline pcurve (the derivative of a cubic span has two roots)
  const int spans = curve->GetType() == GeomAbs_BSplineCurve ? curve->NbKnots() - 1 : curve->GetType() == GeomAbs_BezierCurve ? 1 : 0;
  const int per_interval = std::max(16, 6 * spans), check_samples = std::max(64, 8 * spans);
  std::vector<double> cuts{first, last};
  for (int i = 1; i <= intervals + 1; ++i)
    if (ends(i) > first && ends(i) < last) cuts.push_back(ends(i));
  std::sort(cuts.begin(), cuts.end());
  const std::vector<double> bounds = cuts;
  for (size_t i = 0; i + 1 < bounds.size(); ++i) extremum_cuts(*curve, bounds[i], bounds[i + 1], per_interval, cuts);
  std::sort(cuts.begin(), cuts.end());
  for (size_t i = 0; i + 1 < cuts.size(); ++i) {
    if (!(cuts[i + 1] > cuts[i])) continue;
    out.push_back(make_piece(curve, false, cuts[i], cuts[i + 1], direction));
    if (!is_monotone(out.back(), check_samples)) return false;
  }
  return true;
}

// The area of the parameter domain, the integral of u dv along the boundary (order 24 on every polynomial span of every piece, so exact for a spline pcurve); counter-clockwise outer wires and clockwise holes
// add up to the domain.
inline double domain_area(const std::vector<Piece> &pieces) {
  const Rule rule = gauss_rule(24);
  double area = 0;
  gp_Pnt2d point;
  gp_Vec2d slope;
  for (const Piece &piece : pieces) {
    std::vector<double> ends{piece.ga, piece.gb};
    const int spans = piece.curve->NbIntervals(GeomAbs_CN);
    TColStd_Array1OfReal knots(1, spans + 1);
    piece.curve->Intervals(knots, GeomAbs_CN);
    for (int i = 1; i <= spans + 1; ++i)
      if (knots(i) > piece.ga && knots(i) < piece.gb) ends.push_back(knots(i));
    std::sort(ends.begin(), ends.end());
    for (size_t e = 0; e + 1 < ends.size(); ++e) {
      const double half = 0.5 * (ends[e + 1] - ends[e]), mid = 0.5 * (ends[e + 1] + ends[e]);
      double part = 0;
      for (size_t k = 0; k < rule.x.size(); ++k) {
        piece.curve->D1(mid + half * rule.x[k], point, slope);
        part += rule.w[k] * point.X() * slope.Y();
      }
      area += piece.direction * half * part;
    }
  }
  return area;
}

}  // namespace query
}  // namespace llull

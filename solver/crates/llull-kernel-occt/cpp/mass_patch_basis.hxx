// The B-spline side of the strip integrator (mass_patch.cxx): bases by knot span, the pole rows combined along u, Gauss-Legendre rules.
#pragma once

#include <BRep_Tool.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>

#include <algorithm>
#include <cmath>
#include <vector>

namespace llull {
namespace query {

struct Rule {
  std::vector<double> x, w;
};

// The n-point Gauss-Legendre rule on [-1, 1] (Newton on the Legendre polynomial).
inline Rule gauss_rule(int n) {
  Rule rule;
  rule.x.resize(n), rule.w.resize(n);
  const double pi = 3.14159265358979323846;
  for (int i = 0; i < n; ++i) {
    double z = std::cos(pi * (i + 0.75) / (n + 0.5)), derivative = 1;
    for (int iteration = 0; iteration < 100; ++iteration) {
      double p0 = 1, p1 = z;
      for (int k = 2; k <= n; ++k) {
        const double p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1, p1 = p2;
      }
      derivative = n * (z * p1 - p0) / (z * z - 1);
      const double step = p1 / derivative;
      z -= step;
      if (std::fabs(step) < 1e-16) break;
    }
    rule.x[i] = z;
    rule.w[i] = 2 / ((1 - z * z) * derivative * derivative);
  }
  return rule;
}

// One parametric direction: the flat knot vector, the distinct knots, and for each cell the flat index of the last copy of its lower knot (the span of deBoor).
struct Dir {
  int degree = 0;
  std::vector<double> flat, knots;
  std::vector<int> last;
  int cells() const { return static_cast<int>(knots.size()) - 1; }
  // the cell with knots[c] <= x (clamped)
  int cell_of(double x) const {
    const int c = static_cast<int>(std::upper_bound(knots.begin(), knots.end(), x) - knots.begin()) - 1;
    return std::max(0, std::min(c, cells() - 1));
  }
  // the cell with x <= knots[c + 1], i.e. the last cell whose lower knot is below x
  int cell_below(double x) const {
    const int c = static_cast<int>(std::lower_bound(knots.begin(), knots.end(), x) - knots.begin()) - 1;
    return std::max(0, std::min(c, cells() - 1));
  }
};

inline bool load_dir(int degree, int poles, const TColStd_Array1OfReal &flat, const TColStd_Array1OfReal &knots, const TColStd_Array1OfInteger &mults, Dir &dir) {
  dir.degree = degree;
  if (flat.Length() != poles + degree + 1) return false;
  for (int i = flat.Lower(); i <= flat.Upper(); ++i) dir.flat.push_back(flat(i));
  int seen = 0;
  for (int i = knots.Lower(); i <= knots.Upper(); ++i) {
    dir.knots.push_back(knots(i));
    seen += mults(i);
    dir.last.push_back(seen - 1);
  }
  return dir.knots.size() >= 2;
}

// N[j] = N_{s - p + j, p}(x) for the span s (flat index with flat[s] <= x < flat[s + 1]).
inline void basis(const Dir &dir, int s, double x, int degree, double *N) {
  const double *t = dir.flat.data();
  double left[16], right[16];
  N[0] = 1;
  for (int j = 1; j <= degree; ++j) {
    left[j] = x - t[s + 1 - j];
    right[j] = t[s + j] - x;
    double saved = 0;
    for (int r = 0; r < j; ++r) {
      const double temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
}

inline void basis_and_derivative(const Dir &dir, int s, double x, double *N, double *dN) {
  const int p = dir.degree;
  const double *t = dir.flat.data();
  double low[16];
  basis(dir, s, x, p, N);
  basis(dir, s, x, p - 1, low);
  for (int j = 0; j <= p; ++j) {
    const int i = s - p + j;
    double a = 0, b = 0;
    if (j >= 1 && t[i + p] > t[i]) a = low[j - 1] / (t[i + p] - t[i]);
    if (j <= p - 1 && t[i + p + 1] > t[i + 1]) b = low[j] / (t[i + p + 1] - t[i + 1]);
    dN[j] = p * (a - b);
  }
}

struct Surf {
  Dir u, v;
  int nu = 0, nv = 0;
  std::vector<double> poles;  // [(i * nv + j) * 3 + k]
};

inline bool load_surface(const Handle(Geom_BSplineSurface) & spline, Surf &surf) {
  surf = Surf();
  surf.nu = spline->NbUPoles(), surf.nv = spline->NbVPoles();
  if (!load_dir(spline->UDegree(), surf.nu, spline->UKnotSequence(), spline->UKnots(), spline->UMultiplicities(), surf.u)) return false;
  if (!load_dir(spline->VDegree(), surf.nv, spline->VKnotSequence(), spline->VKnots(), spline->VMultiplicities(), surf.v)) return false;
  surf.poles.reserve(3 * static_cast<size_t>(surf.nu) * surf.nv);
  for (int i = 1; i <= surf.nu; ++i)
    for (int j = 1; j <= surf.nv; ++j) {
      const gp_Pnt &pole = spline->Pole(i, j);
      surf.poles.push_back(pole.X()), surf.poles.push_back(pole.Y()), surf.poles.push_back(pole.Z());
    }
  return true;
}

// The poles combined along u at one u: the curve in v of the surface (q) and of its u derivative (dq), three numbers per column.
struct Row {
  std::vector<double> q, dq;
};

inline void combine_row(const Surf &surf, int span, double x, Row &row) {
  double N[16], dN[16];
  basis_and_derivative(surf.u, span, x, N, dN);
  const size_t width = 3 * static_cast<size_t>(surf.nv);
  row.q.assign(width, 0.0), row.dq.assign(width, 0.0);
  for (int i = 0; i <= surf.u.degree; ++i) {
    const double *poles = &surf.poles[width * static_cast<size_t>(span - surf.u.degree + i)];
    for (size_t m = 0; m < width; ++m) row.q[m] += N[i] * poles[m], row.dq[m] += dN[i] * poles[m];
  }
}

struct VNode {
  double n[16], d[16];
};

inline void evaluate(const Surf &surf, const Row &row, int v_span, const VNode &basis, double *s, double *su, double *sv) {
  s[0] = s[1] = s[2] = su[0] = su[1] = su[2] = sv[0] = sv[1] = sv[2] = 0;
  const int q = surf.v.degree;
  for (int j = 0; j <= q; ++j) {
    const size_t at = 3 * static_cast<size_t>(v_span - q + j);
    for (int k = 0; k < 3; ++k) {
      s[k] += basis.n[j] * row.q[at + k];
      su[k] += basis.n[j] * row.dq[at + k];
      sv[k] += basis.d[j] * row.q[at + k];
    }
  }
}

}  // namespace query
}  // namespace llull

// Parser of the flat deform spec (see deform_spec.hxx).
#include "llull-kernel-occt/cpp/deform_spec.hxx"

#include <algorithm>
#include <cmath>

namespace llull {

using deform::Falloff;
using deform::LawKind;
using deform::Warp;

namespace {

// Spec header (16 numbers, then the law numbers): kind, tolerance, origin[3], axis[3], reference[3], region start, region end, falloff code
// (0 none, 1 linear, 2 smooth), preserveAnalytic, region.infinite (0 / 1: start and end only fix the rate, the law holds on the whole axis).
constexpr int kSpecHeader = 16;

}  // namespace

bool parse_spec(rust::Slice<const double> spec, Warp &warp, double &tolerance, bool &preserve, std::string &why) {
  if (spec.size() < static_cast<size_t>(kSpecHeader)) {
    why = "deform spec too short";
    return false;
  }
  for (double value : spec)
    if (!std::isfinite(value)) {
      why = "deform spec holds a non-finite number";
      return false;
    }
  const int kind = static_cast<int>(spec[0]);
  tolerance = spec[1];
  if (!(tolerance > 0)) {
    why = "tolerance must be > 0";
    return false;
  }
  if (!deform::resolve_frame(&spec[2], &spec[5], &spec[8], warp.frame)) {
    why = "degenerate frame";
    return false;
  }
  warp.region.start = spec[11];
  warp.region.end = spec[12];
  warp.region.falloff = static_cast<Falloff>(static_cast<int>(spec[13]));
  preserve = spec[14] != 0;
  warp.region.infinite = spec[15] != 0;
  if (!(warp.region.end > warp.region.start)) {
    why = "region end must exceed its start";
    return false;
  }
  deform::Law &law = warp.law;
  law.kind = static_cast<LawKind>(kind);
  const double *p = &spec[kSpecHeader];
  const size_t n = spec.size() - static_cast<size_t>(kSpecHeader);
  const auto need = [&](size_t count) {
    if (n < count) why = "deform spec has too few law numbers";
    return n >= count;
  };
  switch (law.kind) {
    case LawKind::Affine:
      if (!need(12)) return false;
      std::copy(p, p + 9, law.matrix);
      std::copy(p + 9, p + 12, law.translation);
      return true;
    case LawKind::Twist:
      if (!need(1)) return false;
      law.angle = p[0];
      return true;
    case LawKind::Taper:
      if (!need(2)) return false;
      law.scale_end = p[0];
      law.flat = p[1] != 0;
      return true;
    case LawKind::Stretch:
      if (!need(1)) return false;
      law.factor = p[0];
      return true;
    case LawKind::Bend:
      if (!need(2)) return false;
      law.radius = p[0];
      law.symmetric = p[1] != 0;
      return law.radius > 0 || (why = "bend radius must be > 0", false);
    case LawKind::Lattice: {
      if (!need(9)) return false;
      deform::Lattice &lattice = law.lattice;
      std::copy(p, p + 3, lattice.min);
      std::copy(p + 3, p + 6, lattice.max);
      for (int a = 0; a < 3; ++a) {
        lattice.degree[a] = static_cast<int>(p[6 + a]);
        if (lattice.degree[a] < 1 || lattice.degree[a] > 8) {
          why = "lattice degree out of 1..8";
          return false;
        }
      }
      const size_t count = 3 * static_cast<size_t>(lattice.degree[0] + 1) * static_cast<size_t>(lattice.degree[1] + 1) *
                           static_cast<size_t>(lattice.degree[2] + 1);
      if (!need(9 + count)) return false;
      lattice.offsets.assign(p + 9, p + 9 + count);
      return true;
    }
    case LawKind::Point:
      if (!need(9)) return false;
      std::copy(p, p + 3, law.center);
      std::copy(p + 3, p + 6, law.direction);
      law.distance = p[6];
      law.support = p[7];
      law.cubic = p[8] != 0;
      return law.support > 0 || (why = "point support radius must be > 0", false);
    case LawKind::Flow: {
      if (!need(4)) return false;
      law.flow.z0 = p[0];
      law.flow.ratio = p[1];
      law.flow.step = p[2];
      const size_t count = static_cast<size_t>(p[3]);
      if (!(law.flow.step > 0) || !(law.flow.ratio > 0) || count < 2 || !need(4 + 12 * count)) {
        if (why.empty()) why = "flow needs step > 0, ratio > 0 and at least 2 stations";
        return false;
      }
      law.flow.stations.assign(p + 4, p + 4 + 12 * count);
      // then the optional base curve: a station count (0 or absent: the frame axis), its step and its stations
      const size_t base_count = n >= 5 + 12 * count ? static_cast<size_t>(p[4 + 12 * count]) : 0;
      if (base_count > 0) {
        if (base_count < 2 || !need(6 + 12 * count + 12 * base_count) || !(p[5 + 12 * count] > 0)) {
          if (why.empty()) why = "flow base curve needs step > 0 and at least 2 stations";
          return false;
        }
        law.flow.base_step = p[5 + 12 * count];
        law.flow.base.assign(p + 6 + 12 * count, p + 6 + 12 * count + 12 * base_count);
      }
      return true;
    }
    case LawKind::Rbf: {
      if (!need(1)) return false;
      const size_t count = static_cast<size_t>(p[0]);
      if (count < 1 || !need(1 + 6 * count + 12)) {
        if (why.empty()) why = "rbf needs at least one centre";
        return false;
      }
      law.rbf.centres.assign(p + 1, p + 1 + 3 * count);
      law.rbf.weights.assign(p + 1 + 3 * count, p + 1 + 6 * count);
      std::copy(p + 1 + 6 * count, p + 1 + 6 * count + 12, law.rbf.affine);
      return true;
    }
    case LawKind::FlowSurface: {
      if (!need(6)) return false;
      deform::FlowSurface &table = law.surface;
      table.x0 = p[0];
      table.y0 = p[1];
      table.hx = p[2];
      table.hy = p[3];
      table.nx = static_cast<int>(p[4]);
      table.ny = static_cast<int>(p[5]);
      if (!(table.hx > 0) || !(table.hy > 0) || table.nx < 2 || table.ny < 2 || !need(6 + 6 * static_cast<size_t>(table.nx) * static_cast<size_t>(table.ny))) {
        if (why.empty()) why = "flow onto a surface needs hx, hy > 0 and a table of at least 2 by 2 nodes";
        return false;
      }
      table.nodes.assign(p + 6, p + 6 + 6 * static_cast<size_t>(table.nx) * static_cast<size_t>(table.ny));
      return true;
    }
  }
  why = "unknown deform law";
  return false;
}

}  // namespace llull

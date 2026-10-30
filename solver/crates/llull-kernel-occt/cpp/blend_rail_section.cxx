// The section of a rail-preserving profile blend at one station (BLD M2, TECHNICAL_SPEC §13.11, §13.16): contact points on both supports, the apex of their
// tangent lines, the ball centre, the curvature offsets of a G2 section, and the mitre displacement of a blend that ends on a crease.
#include <algorithm>
#include <cmath>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <GC_MakeCircle.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {
namespace rails {

namespace {

// A contact point moves onto its support face when it is that close (x the distance to the apex): OCCT's approximation error, not a different point.
constexpr double kSnapFraction = 1e-3;

// The support face of rail `side` at `along`.
TopoDS_Face support_at(const Blend &blend, int side, double along) {
  const RailPiece *best = nullptr;
  double gap = 1e300;
  for (const RailPiece &piece : blend.supports[side]) {
    const double away = along < piece.lo ? piece.lo - along : (along > piece.hi ? along - piece.hi : 0.0);
    if (away < gap) {
      gap = away;
      best = &piece;
    }
  }
  return best == nullptr ? TopoDS_Face() : best->face;
}

}  // namespace

void apply_mitre(const Blend &blend, double along, Section &section) {
  for (int end = 0; end < 2; ++end) {
    const Mitre &mitre = blend.mitre[end];
    if (!mitre.active) continue;
    const double x = 1.0 - (end == 0 ? along - blend.lo : blend.hi - along) / mitre.length;
    if (x <= 0) continue;
    // quintic smoother step: 0 at the start of the transition, 1 at the end, with zero first and second derivatives at both
    const double fade = x >= 1 ? 1.0 : x * x * x * (10.0 + x * (-15.0 + 6.0 * x));
    section.a.Translate(mitre.shift[0] * fade);
    section.t.Translate(mitre.shift[1] * fade);
    section.b.Translate(mitre.shift[2] * fade);
    section.centre.Translate(mitre.shift[3] * fade);
  }
}

// The section circle of a blend at `along`: contact points on both rails, the arc midpoint, and the apex of the two tangent lines.
bool section_at(const BRepAdaptor_Surface &surface, const Blend &blend, double along, bool curved, double shape, Section &out, std::string &why) {
  const auto at = [&](double across) {
    return blend.across_is_u ? surface.Value(across, along) : surface.Value(along, across);
  };
  const gp_Pnt a = at(blend.across[0]), b = at(blend.across[1]), m = at(0.5 * (blend.across[0] + blend.across[1]));
  GC_MakeCircle circle(a, m, b);
  if (!circle.IsDone()) {
    why = "a section of the circular blend is not a circle arc";
    return false;
  }
  const gp_Pnt centre = circle.Value()->Location();
  const double radius = circle.Value()->Radius();
  gp_Vec to_a(centre, a), to_b(centre, b);
  gp_Vec bisector = to_a / radius + to_b / radius;
  if (bisector.Magnitude() < 1e-6) {
    why = "a section of the circular blend is a half circle or more";
    return false;
  }
  bisector.Normalize();
  const double half_cos = to_a.Dot(bisector) / radius;
  if (half_cos < 1e-3 || bisector.Dot(gp_Vec(centre, m)) <= 0) {
    why = "a section of the circular blend turns through 180 degrees or more (no apex)";
    return false;
  }
  // The circular blend's contact points carry OCCT's own approximation error (up to ~1e-6 in absolute terms, more than 1e-6 x the diagonal on a
  // millimetre part): they are moved onto the support faces, so the profile meets them to the interpolation accuracy only.
  Section raw;
  raw.a = a;
  raw.b = b;
  raw.centre = centre;
  raw.circle_weight = half_cos;
  raw.t = centre.Translated(bisector * (radius / half_cos));
  apply_mitre(blend, along, raw);
  out = raw;
  const gp_Pnt contacts[2] = {raw.a, raw.b};
  for (int side = 0; side < 2; ++side) {
    gp_Pnt on;
    const TopoDS_Face support = support_at(blend, side, along);
    if (support.IsNull() || !project_on_face(support, contacts[side], on)) continue;
    if (on.Distance(contacts[side]) <= kSnapFraction * out.t.Distance(contacts[side])) (side == 0 ? out.a : out.b) = on;
  }
  if (!curved) return true;
  // G2: the section leaves each support with the support's own curvature along the section (the quintic of section_poles).
  const gp_Pnt snapped[2] = {out.a, out.b};
  for (int side = 0; side < 2; ++side) {
    const gp_Pnt from = snapped[side], other = snapped[1 - side];
    const double reach = from.Distance(out.t);
    gp_Vec nu;
    double kappa = 0;
    if (!(reach > 0) || !support_curvature(support_at(blend, side, along), from, gp_Vec(from, out.t), gp_Vec(from, other), nu, kappa)) {
      why = "the curvature of a support face could not be read at a contact point";
      return false;
    }
    const double lead = 0.8 * shape * reach;
    const double offset = std::max(-0.25 * reach, std::min(0.25 * reach, 1.25 * kappa * lead * lead));
    (side == 0 ? out.bend_a : out.bend_b) = nu * offset;
  }
  return true;
}

bool plan_fade(const BRepAdaptor_Surface &surface, const Blend &blend, double reach_factor, Fade &fade, std::string &why) {
  fade = Fade();
  if (blend.closed) return true;
  constexpr int kSamples = 96;
  fade.along.clear();
  fade.arc.clear();
  gp_Pnt previous;
  double arc = 0, chord[2] = {0, 0};
  for (int j = 0; j <= kSamples; ++j) {
    const double at = blend.lo + (blend.hi - blend.lo) * j / kSamples;
    Section station;
    if (!section_at(surface, blend, at, false, 0.5, station, why)) return false;
    if (j > 0) arc += station.centre.Distance(previous);
    previous = station.centre;
    fade.along.push_back(at);
    fade.arc.push_back(arc);
    if (j == 0) chord[0] = station.a.Distance(station.b);
    if (j == kSamples) chord[1] = station.a.Distance(station.b);
  }
  for (int end = 0; end < 2; ++end) {
    if (blend.end_blend[end].IsNull() || blend.mitre[end].active) continue;
    fade.at[end] = true;
    fade.reach[end] = std::min(reach_factor * chord[end], 0.45 * arc);
    fade.active = true;
  }
  return true;
}

double faded_weight(const Fade &fade, double along, double circle_weight, double profile_weight) {
  if (!fade.active) return profile_weight;
  const auto where = std::upper_bound(fade.along.begin(), fade.along.end(), along);
  const size_t hi = std::min<size_t>(static_cast<size_t>(where - fade.along.begin()), fade.along.size() - 1);
  const size_t lo = hi > 0 ? hi - 1 : 0;
  const double span = fade.along[hi] - fade.along[lo];
  const double x = span > 0 ? (along - fade.along[lo]) / span : 0.0;
  const double here = fade.arc[lo] + x * (fade.arc[hi] - fade.arc[lo]);
  double share = 1.0;
  for (int end = 0; end < 2; ++end) {
    if (!fade.at[end]) continue;
    const double distance = end == 0 ? here : fade.arc.back() - here;
    const double t = std::max(0.0, std::min(1.0, distance / fade.reach[end]));
    share = std::min(share, t * t * t * (10.0 + t * (-15.0 + 6.0 * t)));
  }
  return circle_weight + share * (profile_weight - circle_weight);
}

std::string number(double value) {
  std::ostringstream text;
  text.precision(6);
  text << value;
  return text.str();
}

bool circular_section_volume(const Blend &blend, double &volume, std::string &why) {
  constexpr int kIntervals = 48;
  const BRepAdaptor_Surface surface(blend.face, Standard_False);
  Section previous;
  double previous_area = 0;
  volume = 0;
  for (int j = 0; j <= kIntervals; ++j) {
    Section station;
    if (!section_at(surface, blend, blend.lo + (blend.hi - blend.lo) * j / kIntervals, false, 0.5, station, why)) return false;
    const double radius = station.a.Distance(station.centre);
    const double angle = 2.0 * std::asin(std::min(1.0, station.a.Distance(station.b) / (2.0 * radius)));
    const double triangle = 0.5 * gp_Vec(station.t, station.a).Crossed(gp_Vec(station.t, station.b)).Magnitude();
    const double area = triangle - 0.5 * radius * radius * (angle - std::sin(angle));
    if (j > 0) volume += 0.5 * (area + previous_area) * station.centre.Distance(previous.centre);
    previous = station;
    previous_area = area;
  }
  return true;
}

double result_diagonal(const TopoDS_Shape &solid, const std::vector<TopoDS_Shape> &blend_images) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(solid, TopAbs_FACE, faces);
  Bnd_Box box;
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    const bool blended = std::any_of(blend_images.begin(), blend_images.end(), [&](const TopoDS_Shape &image) { return image.IsSame(face); });
    if (!blended) {
      BRepBndLib::AddOptimal(face, box, Standard_False, Standard_False);
      continue;
    }
    const Handle(Geom_BSplineSurface) spline = Handle(Geom_BSplineSurface)::DownCast(BRep_Tool::Surface(face));
    const BRepAdaptor_Surface surface(face, Standard_False);
    const int across = 16, along = 8 * std::max(2, spline.IsNull() ? 0 : spline->NbVKnots());
    for (int i = 0; i <= across; ++i)
      for (int j = 0; j <= along; ++j)
        box.Add(surface.Value(surface.FirstUParameter() + (surface.LastUParameter() - surface.FirstUParameter()) * i / across,
                              surface.FirstVParameter() + (surface.LastVParameter() - surface.FirstVParameter()) * j / along));
  }
  if (box.IsVoid()) return 0.0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return gp_Pnt(x0, y0, z0).Distance(gp_Pnt(x1, y1, z1));
}

}  // namespace rails
}  // namespace blend
}  // namespace llull

// The fade of a conic to the circular arc at the ends of a blend that meet the next blend of its chain (BLD M2, TECHNICAL_SPEC §13.19): where it ends, how
// long it is, the weight of the section along it.
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Standard_Handle.hxx>
#include <gp_Pnt.hxx>

#include "llull-kernel-occt/cpp/blend_rails.hxx"

namespace llull {
namespace blend {
namespace rails {

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


bool positive_weights(const Handle(Geom_BSplineCurve) &weights, std::string &why) {
  // a NURBS surface needs every weight above zero: the interpolated weight curve between the profile's and the circle's cannot leave that range on its own,
  // but a pole of it is the weight times nothing the construction bounds
  for (int j = 1; j <= weights->NbPoles(); ++j)
    if (!(weights->Pole(j).X() > kLeastWeight)) {
      why = "the section weights of a faded blend leave the positive range (" + number(weights->Pole(j).X()) + ")";
      return false;
    }
  return true;
}

}  // namespace rails
}  // namespace blend
}  // namespace llull

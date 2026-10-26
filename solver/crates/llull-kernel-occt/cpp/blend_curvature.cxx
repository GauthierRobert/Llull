// Curvature of a support face along a blend section (BLD M2, TECHNICAL_SPEC §5.3 and §13.11): what a curvature-continuous (G2) profile must match at
// its contact point. Definitions of blend_tool.hxx.
#include <cmath>

#include <BRepAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <TopLoc_Location.hxx>
#include <gp_Trsf.hxx>

#include "llull-kernel-occt/cpp/blend_tool.hxx"

namespace llull {
namespace blend {

bool project_on_face(const TopoDS_Face &support, const gp_Pnt &point, gp_Pnt &on) {
  TopLoc_Location location;
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(support, location);
  if (surface.IsNull()) return false;
  const gp_Trsf placement = location.Transformation();
  GeomAPI_ProjectPointOnSurf projection(point.Transformed(placement.Inverted()), surface);
  if (projection.NbPoints() < 1) return false;
  on = projection.NearestPoint().Transformed(placement);
  return true;
}

bool support_curvature(const TopoDS_Face &support, const gp_Pnt &point, const gp_Vec &direction, const gp_Vec &toward, gp_Vec &nu, double &kappa) {
  TopLoc_Location location;
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(support, location);
  if (surface.IsNull()) return false;
  const gp_Trsf placement = location.Transformation();
  const gp_Pnt local = point.Transformed(placement.Inverted());
  GeomAPI_ProjectPointOnSurf projection(local, surface);
  if (projection.NbPoints() < 1) return false;
  double u = 0, v = 0;
  projection.LowerDistanceParameters(u, v);
  gp_Pnt on;
  gp_Vec su, sv, suu, svv, suv;
  surface->D2(u, v, on, su, sv, suu, svv, suv);
  gp_Vec normal = su.Crossed(sv);
  if (normal.Magnitude() < 1e-14) return false;
  normal.Normalize();
  gp_Vec local_direction = direction.Transformed(placement.Inverted());
  // direction = alpha su + beta sv (least squares in the tangent plane)
  const double e = su.Dot(su), f = su.Dot(sv), g = sv.Dot(sv);
  const double determinant = e * g - f * f;
  if (std::fabs(determinant) < 1e-18) return false;
  const double rhs_u = local_direction.Dot(su), rhs_v = local_direction.Dot(sv);
  const double alpha = (g * rhs_u - f * rhs_v) / determinant, beta = (e * rhs_v - f * rhs_u) / determinant;
  const gp_Vec acceleration = suu * (alpha * alpha) + suv * (2.0 * alpha * beta) + svv * (beta * beta);
  // The section curve bends toward the side `toward` (from the contact point to the other one): that side of the surface normal.
  const gp_Vec local_toward = toward.Transformed(placement.Inverted());
  if (normal.Dot(local_toward) < 0) normal.Reverse();
  const double speed = local_direction.Magnitude();
  if (speed < 1e-14) return false;
  kappa = acceleration.Dot(normal) / (speed * speed);
  nu = normal.Transformed(placement);
  return true;
}

}  // namespace blend
}  // namespace llull

// Area, volume, centroid and inertia of the non-rational B-spline faces of a shape by strips (06 BLD 13.48). BRepGProp integrates such a face point by point (deBoor per point, a Gauss order
// of its own per span); here the face is cut along its parameter lines into strips, each strip is integrated with Gauss rules whose order follows the degree of the integrand (exact for a
// polynomial integrand), and the surface is evaluated by rows (the poles combined along u once per u node, then one short dot product per v node). A trimmed face is read through its pcurves.
#pragma once

#include <GProp_GProps.hxx>
#include <TopoDS_Shape.hxx>

namespace llull {
namespace query {

// Sets `out` to the area properties (mass = area, centre, inertia about a reference point near the shape, which is its reference point) of every eligible face of `shape` to `out`, the other faces by BRepGProp::SurfaceProperties (fixed rule). False
// (and `out` untouched) when no face is eligible: the caller then runs BRepGProp as it always did.
bool fast_surface_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// The same for the volume properties (cones from the reference point; the faces left to BRepGProp are integrated with the same apex). A shape with a face outside a closed shell is refused (false): the cones of an
// open shell depend on the apex, and BRepGProp does not take the origin for it.
bool fast_volume_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// BRepGProp::VolumeProperties / SurfaceProperties(shape, props) with its default arguments: the B-spline faces of many knot cells by strips, the others (and a shape with none) by BRepGProp.
void volume_properties(const TopoDS_Shape &shape, GProp_GProps &out);
void surface_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// Test hook: switches the strip integrator on (default) or off (every face by BRepGProp).
void set_patch_integrator(bool on);
void set_patch_order(int order);
// The agreement the order search asks for (0: the default 1e-11); a negative tolerance makes every face fall back to BRepGProp at once.
void set_patch_agreement(double tolerance);
// Test hook: caps the samples per interval of a curved pcurve (0: no cap) so that the guards (monotone check, parameter-domain check) are what decides; every n-th face refused (0: none).
void set_patch_sampling_cap(int samples);
void set_patch_refuse_every(int n);
// Test hook: why the last face was left to BRepGProp (0 none yet, 1 unreadable boundary, 2 integration failed, 3 orders did not agree, 4 parameter domain mismatch, 5 refused by the test hook).
int last_patch_refusal();
// Test hook: the relative mismatch of the two parameter-domain areas of the last face.
double last_domain_gap();

// Test hook: how many faces of `shape` the strip integrator takes.
int eligible_patch_faces(const TopoDS_Shape &shape);

}  // namespace query
}  // namespace llull

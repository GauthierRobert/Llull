// Area, volume, centroid and inertia of the non-rational B-spline faces of a shape by strips (06 BLD 13.48). BRepGProp integrates such a face point by point (deBoor per point, a Gauss order
// of its own per span); here the face is cut along its parameter lines into strips, each strip is integrated with Gauss rules whose order follows the degree of the integrand (exact for a
// polynomial integrand), and the surface is evaluated by rows (the poles combined along u once per u node, then one short dot product per v node). A trimmed face is read through its pcurves.
#pragma once

#include <GProp_GProps.hxx>
#include <TopoDS_Shape.hxx>

namespace llull {
namespace query {

// Adds the area properties (mass = area, centre, inertia about the origin) of every eligible face of `shape` to `out`, the other faces by BRepGProp::SurfaceProperties (fixed rule). False
// (and `out` untouched) when no face is eligible: the caller then runs BRepGProp as it always did.
bool fast_surface_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// The same for the volume properties (cones from the origin). A shape with a face outside a closed shell is refused (false): the cones of an open shell depend on the apex, and BRepGProp
// does not take the origin for it.
bool fast_volume_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// BRepGProp::VolumeProperties / SurfaceProperties(shape, props) with its default arguments: the B-spline faces of many knot cells by strips, the others (and a shape with none) by BRepGProp.
void volume_properties(const TopoDS_Shape &shape, GProp_GProps &out);
void surface_properties(const TopoDS_Shape &shape, GProp_GProps &out);

// Test hook: switches the strip integrator on (default) or off (every face by BRepGProp).
void set_patch_integrator(bool on);
void set_patch_order(int order);

// Test hook: how many faces of `shape` the strip integrator takes.
int eligible_patch_faces(const TopoDS_Shape &shape);

}  // namespace query
}  // namespace llull

// preserveAnalytic (01 DEF FR-DEF-12, §17.11): after the exact warp every face is a fitted B-spline; the faces that are a plane, cylinder, cone or sphere within a tolerance are
// rebuilt on the analytic surface (ShapeAnalysis_CanonicalRecognition), keeping their wires, orientation and the 3D edges.
#pragma once

#include <TopTools_DataMapOfShapeShape.hxx>
#include <TopoDS_Shape.hxx>

namespace llull {
namespace deform {

struct Recognised {
  int tried = 0;  // B-spline faces looked at
  int rejected = 0;  // recognised, but the rebuilt face is not a valid face: kept as fitted
  int status = 0;  // the first BRepCheck status that made a rebuild invalid (face: 1000 + status)
  int plane = 0;
  int cylinder = 0;
  int cone = 0;
  int sphere = 0;
  int from_source = 0;  // recognised by the surface of the source face rather than by OCCT
  double replaced_area = 0;  // area of the faces that were replaced (the bound of the volume they can move)
  double worst_gap = 0;  // largest distance between a replaced face and its fitted surface
  int total() const { return plane + cylinder + cone + sphere; }
};

// `result` with the recognisable faces replaced; `replaced` maps each old face to its new one (for the naming history). The input is returned unchanged when nothing is
// recognised. A face whose analytic rebuild is not a valid face is kept as it was.
// `origin` maps a face of `result` to the source face it is the image of: a face OCCT cannot recognise (its parameterisation moved: a twisted cylinder) is also tried against the
// analytic surface of its source (a twist about the axis keeps a cylinder, a stretch along it too, a plane normal to the axis stays that plane), by the distance of sample points.
TopoDS_Shape recognise_analytic(const TopoDS_Shape &result, double tolerance, const TopTools_DataMapOfShapeShape &origin, Recognised &counts,
                                TopTools_DataMapOfShapeShape &replaced);

}  // namespace deform
}  // namespace llull

// Topology work of the exact warp (01 DEF M2, TECHNICAL_SPEC §5.6): splitting faces where a law is not analytic, the full-turn ring (drop the
// two coincident end caps) and sewing it closed again.
#include "llull-kernel-occt/cpp/deform_topology.hxx"
#include "llull-kernel-occt/cpp/mass_spans.hxx"

#include <algorithm>
#include <cmath>
#include <Geom2d_Curve.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepCheck_ListIteratorOfListOfStatus.hxx>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_ModifyShape.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepTools.hxx>
#include <BRepTools_History.hxx>
#include <BRepTools_Modification.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <ShapeFix_Shape.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <Precision.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pln.hxx>
#include <gp_Trsf.hxx>
#include <BRepBuilderAPI_Transform.hxx>

#include "llull-kernel-occt/cpp/deform_fit.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"


namespace llull {

using deform::LawKind;
using deform::Warp;

constexpr double kPi = 3.14159265358979323846;

int count_faces(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  return faces.Extent();
}

// Corners of the shape's bounding box projected on the frame axis `axis` (0 x, 1 y, 2 z): the range [low, high] the body spans there.
void span_along_direction(const TopoDS_Shape &shape, const deform::Frame &frame, const double *direction, double &low, double &high) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
  low = std::numeric_limits<double>::infinity();
  high = -low;
  const gp_Pnt a = box.CornerMin(), b = box.CornerMax();
  for (int corner = 0; corner < 8; ++corner) {
    const double x = (corner & 1 ? b : a).X(), y = (corner & 2 ? b : a).Y(), z = (corner & 4 ? b : a).Z();
    const double t = (x - frame.origin[0]) * direction[0] + (y - frame.origin[1]) * direction[1] + (z - frame.origin[2]) * direction[2];
    low = std::min(low, t);
    high = std::max(high, t);
  }
}

void span_along(const TopoDS_Shape &shape, const deform::Frame &frame, int axis, double &low, double &high) {
  span_along_direction(shape, frame, axis == 0 ? frame.x : axis == 1 ? frame.y : frame.z, low, high);
}

// Places where the law is not analytic and a face must not straddle: region ends for the axis laws, lattice box faces.
std::vector<Cut> cuts_of(const Warp &warp, const TopoDS_Shape &shape) {
  std::vector<Cut> cuts;
  const auto add = [&](int axis, double offset, double margin) {
    double low = 0, high = 0;
    span_along(shape, warp.frame, axis, low, high);
    if (offset > low + margin && offset < high - margin) cuts.push_back({axis, offset});
  };
  const double margin = 1e-7;
  switch (warp.law.kind) {
    case LawKind::Twist:
    case LawKind::Taper:
    case LawKind::Stretch:
    case LawKind::Bend:
      if (warp.region.infinite) break;  // no kink at the region ends: the law is one analytic map on the whole axis
      add(2, warp.region.start, margin);
      add(2, warp.region.end, margin);
      break;
    case LawKind::Lattice: {
      const deform::Lattice &lattice = warp.law.lattice;
      if (!lattice.oriented) {
        for (int a = 0; a < 3; ++a) {
          add(a, lattice.min[a], margin);
          add(a, lattice.max[a], margin);
        }
        break;
      }
      for (int a = 0; a < 3; ++a) {
        // the face c_a = min / max of the oriented box: normal = row a of the axes in local coordinates, as a world vector for the span
        double world[3];
        for (int k = 0; k < 3; ++k)
          world[k] = lattice.axes[3 * a] * warp.frame.x[k] + lattice.axes[3 * a + 1] * warp.frame.y[k] + lattice.axes[3 * a + 2] * warp.frame.z[k];
        double low = 0, high = 0;
        span_along_direction(shape, warp.frame, world, low, high);
        for (const double offset : {lattice.min[a], lattice.max[a]}) {
          if (!(offset > low + margin && offset < high - margin)) continue;
          Cut cut{a, offset, true, {lattice.axes[3 * a], lattice.axes[3 * a + 1], lattice.axes[3 * a + 2]}};
          cuts.push_back(cut);
        }
      }
      break;
    }
    default:
      break;
  }
  return cuts;
}

// The range of local z the body spans, measured in the frame's own coordinates (the shape moved into the frame, then its tight box): the corners of
// the world-aligned box project to a wider range on an oblique axis, which would refuse a body the mesh path accepts.
static void frame_z_span(const TopoDS_Shape &shape, const deform::Frame &frame, double &low, double &high) {
  gp_Trsf to_frame;
  to_frame.SetTransformation(gp_Ax3(gp_Pnt(frame.origin[0], frame.origin[1], frame.origin[2]), gp_Dir(frame.z[0], frame.z[1], frame.z[2]),
                                    gp_Dir(frame.x[0], frame.x[1], frame.x[2])));
  BRepBuilderAPI_Transform moved(shape, to_frame, Standard_False);
  Bnd_Box box;
  BRepBndLib::AddOptimal(moved.Shape(), box, Standard_False, Standard_False);
  low = box.CornerMin().Z();
  high = box.CornerMax().Z();
}

bool taper_scale_vanishes(const Warp &warp, const TopoDS_Shape &shape) {
  const deform::Law &law = warp.law;
  if (law.kind != LawKind::Taper || law.flat || !warp.region.infinite) return false;
  double low = 0, high = 0;
  frame_z_span(shape, warp.frame, low, high);
  const double rate = (law.scale_end - 1) / (warp.region.end - warp.region.start);
  const double s_low = 1 + rate * (low - warp.region.start), s_high = 1 + rate * (high - warp.region.start);
  // s is linear in z: s <= 0 anywhere on the body is a fold (a sign change, or a body wholly past the zero, which s^2 hides)
  return s_low <= 0 || s_high <= 0;
}

// `shape` with every face split along the planes of `cuts`; the shells are rebuilt from the split faces so the result stays one solid.
TopoDS_Shape split_faces(const TopoDS_Shape &shape, const Warp &warp, const std::vector<Cut> &cuts, std::vector<naming::Named> &named,
                         int &split_count) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
  const double size = 2 * box.CornerMin().Distance(box.CornerMax()) + 1;
  TopTools_ListOfShape faces, tools;
  TopTools_IndexedMapOfShape distinct;
  TopExp::MapShapes(shape, TopAbs_FACE, distinct);
  for (int f = 1; f <= distinct.Extent(); ++f) faces.Append(distinct(f));
  for (const Cut &cut : cuts) {
    double oriented[3];
    for (int k = 0; k < 3; ++k)
      oriented[k] = cut.direction[0] * warp.frame.x[k] + cut.direction[1] * warp.frame.y[k] + cut.direction[2] * warp.frame.z[k];
    const double *direction = cut.oriented ? oriented : (cut.axis == 0 ? warp.frame.x : cut.axis == 1 ? warp.frame.y : warp.frame.z);
    const gp_Pnt at(warp.frame.origin[0] + direction[0] * cut.offset, warp.frame.origin[1] + direction[1] * cut.offset,
                    warp.frame.origin[2] + direction[2] * cut.offset);
    const gp_Pln plane(at, gp_Dir(direction[0], direction[1], direction[2]));
    tools.Append(BRepBuilderAPI_MakeFace(plane, -size, size, -size, size).Face());
  }
  BRepAlgoAPI_Splitter splitter;
  splitter.SetArguments(faces);
  splitter.SetTools(tools);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) return TopoDS_Shape();
  BRep_Builder builder;
  // Rebuild: every face of every shell of the input is replaced by its split images (or kept).
  const auto rebuild_shell = [&](const TopoDS_Shell &old_shell) {
    TopoDS_Shell shell;
    builder.MakeShell(shell);
    for (TopoDS_Iterator it(old_shell); it.More(); it.Next()) {
      const TopoDS_Shape &old_face = it.Value();
      const TopTools_ListOfShape &images = splitter.Modified(old_face);
      if (images.IsEmpty()) {
        if (!splitter.IsDeleted(old_face)) builder.Add(shell, old_face);
        continue;
      }
      for (TopTools_ListIteratorOfListOfShape image(images); image.More(); image.Next()) builder.Add(shell, image.Value());
    }
    shell.Closed(old_shell.Closed());
    return shell;
  };
  TopoDS_Shape rebuilt;
  if (shape.ShapeType() == TopAbs_SOLID) {
    TopoDS_Solid solid;
    builder.MakeSolid(solid);
    for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
      if (it.Value().ShapeType() == TopAbs_SHELL) builder.Add(solid, rebuild_shell(TopoDS::Shell(it.Value())));
      else builder.Add(solid, it.Value());
    }
    rebuilt = solid;
  } else if (shape.ShapeType() == TopAbs_SHELL) {
    rebuilt = rebuild_shell(TopoDS::Shell(shape));
  } else {
    return TopoDS_Shape();
  }
  // Names: a split face keeps the name of its parent.
  Handle(BRepTools_History) history = new BRepTools_History();
  for (int f = 1; f <= distinct.Extent(); ++f) {
    const TopTools_ListOfShape &images = splitter.Modified(distinct(f));
    for (TopTools_ListIteratorOfListOfShape image(images); image.More(); image.Next()) history->AddModified(distinct(f), image.Value());
  }
  const std::vector<naming::Named> before = named;
  named = {naming::Named{rebuilt, naming::inherit(rebuilt, before, history, "deform")}};
  split_count = std::max(0, count_faces(rebuilt) - count_faces(shape));
  return rebuilt;
}

// A full-turn bend: its two end caps land on each other. Returns the shape without the planar faces at the region ends, or null shape when this
// deformation is not a full-turn ring.
TopoDS_Shape ring_without_caps(const TopoDS_Shape &shape, const Warp &warp, double tolerance, bool &full_turn) {
  full_turn = false;
  const deform::Law &law = warp.law;
  if (law.kind != LawKind::Bend || law.symmetric || warp.region.infinite) return TopoDS_Shape();
  double low = 0, high = 0;
  span_along(shape, warp.frame, 2, low, high);
  if (low < warp.region.start - tolerance || high > warp.region.end + tolerance) return TopoDS_Shape();
  if (std::fabs((high - warp.region.start) - 2 * kPi * law.radius) > 2 * tolerance) return TopoDS_Shape();
  full_turn = true;
  BRep_Builder builder;
  TopoDS_Shell shell;
  builder.MakeShell(shell);
  std::vector<TopoDS_Face> caps;
  TopTools_IndexedMapOfShape distinct;
  TopExp::MapShapes(shape, TopAbs_FACE, distinct);
  for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    const BRepAdaptor_Surface surface(face, Standard_True);
    bool cap = false;
    if (surface.GetType() == GeomAbs_Plane) {
      const gp_Dir normal = surface.Plane().Axis().Direction();
      const gp_Pnt at = surface.Plane().Location();
      const double along = std::fabs(normal.X() * warp.frame.z[0] + normal.Y() * warp.frame.z[1] + normal.Z() * warp.frame.z[2]);
      const double height = (at.X() - warp.frame.origin[0]) * warp.frame.z[0] + (at.Y() - warp.frame.origin[1]) * warp.frame.z[1] +
                            (at.Z() - warp.frame.origin[2]) * warp.frame.z[2];
      cap = along > 1 - 1e-9 && (std::fabs(height - low) < tolerance || std::fabs(height - high) < tolerance);
    }
    if (cap) caps.push_back(face);
    else builder.Add(shell, face);
  }
  if (caps.size() != 2) return TopoDS_Shape();
  // the ends land on each other only when they are the same face: equal area and equal outline length (a rounded end against a plain one is not a ring)
  GProp_GProps first_area, second_area, first_outline, second_outline;
  BRepGProp::SurfaceProperties(caps[0], first_area);
  BRepGProp::SurfaceProperties(caps[1], second_area);
  BRepGProp::LinearProperties(caps[0], first_outline);
  BRepGProp::LinearProperties(caps[1], second_outline);
  const double outline = std::max(first_outline.Mass(), second_outline.Mass());
  if (std::fabs(first_area.Mass() - second_area.Mass()) > 2 * tolerance * outline + 1e-9 * first_area.Mass() ||
      std::fabs(first_outline.Mass() - second_outline.Mass()) > 2 * tolerance)
    return TopoDS_Shape();
  return TopoDS_Shape(shell);
}

// The shell(s) of `open` sewn at `tolerance` into one solid; null shape when sewing does not close it.
TopoDS_Shape sewn_solid(const TopoDS_Shape &open, double tolerance) {
  BRepBuilderAPI_Sewing sewing(tolerance, Standard_True, Standard_True, Standard_True, Standard_False);
  sewing.Add(open);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) return TopoDS_Shape();
  TopoDS_Shell shell;
  if (sewn.ShapeType() == TopAbs_SHELL) {
    shell = TopoDS::Shell(sewn);
  } else if (sewn.ShapeType() == TopAbs_FACE) {  // one face closed on itself
    BRep_Builder builder;
    builder.MakeShell(shell);
    builder.Add(shell, sewn);
  } else {
    TopExp_Explorer explorer(sewn, TopAbs_SHELL);
    if (!explorer.More()) return TopoDS_Shape();
    shell = TopoDS::Shell(explorer.Current());
  }
  BRepBuilderAPI_MakeSolid maker(shell);
  return maker.IsDone() ? TopoDS_Shape(maker.Solid()) : TopoDS_Shape();
}

double signed_volume(const TopoDS_Shape &shape) {
  GProp_GProps props;
  // a graded full-patch B-spline face (a local push on a large face) is cut into its knot spans first: the whole-face rule reads a narrow bump as flat (mass_spans.hxx, 01 DEF 17.16)
  int cut = 0;
  const TopoDS_Compound spans = query::span_faces(shape, cut);
  if (cut > 0) BRepGProp::VolumeProperties(spans, props, Standard_False, Standard_False, Standard_False);
  else BRepGProp::VolumeProperties(shape, props, Standard_True, Standard_False, Standard_False);
  return props.Mass();
}


}  // namespace llull

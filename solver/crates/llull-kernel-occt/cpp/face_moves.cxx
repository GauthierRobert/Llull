// Face moves and deletion of the native kernel (04 DIR M6). Delete: BRepAlgoAPI_Defeaturing. Offset: BRepOffset_MakeOffset with a zero global
// offset and a per-face offset (SetOffsetOnFace). Translate / rotate: one planar face goes through push-pull / DraftAngle (the new plane is all that
// matters, the neighbours extend); any other face set is a FEATURE: it is defeatured away, the volume it removed / added is moved rigidly and
// cut / fused back. Every result must be one valid solid; all keep the persistent face names of naming.hxx (a moved face keeps its name).
#include "llull-kernel-occt/cpp/features.hxx"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <ShapeFix_Solid.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Ax1.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/src/features.rs.h"

namespace llull {

namespace {

constexpr double kOffsetTolerance = 1e-4;
constexpr double kNegligibleVolume = 1e-9;

TopTools_IndexedMapOfShape faces_of(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_FACE, map);
  return map;
}

// The faces at `indices` (empty when one is out of range or none is given).
std::vector<TopoDS_Face> picked_faces(const TopoDS_Shape &shape, rust::Slice<const uint32_t> indices) {
  const TopTools_IndexedMapOfShape all = faces_of(shape);
  std::vector<TopoDS_Face> picked;
  for (uint32_t index : indices) {
    if (static_cast<int>(index) >= all.Extent()) return {};
    picked.push_back(TopoDS::Face(all(static_cast<int>(index) + 1)));
  }
  return picked;
}

double volume_of(const TopoDS_Shape &shape) {
  GProp_GProps properties;
  BRepGProp::VolumeProperties(shape, properties);
  return properties.Mass();
}

int solid_count(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(shape, TopAbs_SOLID, solids);
  return solids.Extent();
}

// `shape` when it is a solid, else the only solid of a compound; null otherwise.
TopoDS_Shape single_solid(const TopoDS_Shape &shape) {
  if (shape.IsNull()) return shape;
  if (shape.ShapeType() == TopAbs_SOLID) return shape;
  return solid_count(shape) == 1 ? TopExp_Explorer(shape, TopAbs_SOLID).Current() : TopoDS_Shape();
}

bool sound(const TopoDS_Shape &shape) { return !shape.IsNull() && solid_count(shape) == 1 && BRepCheck_Analyzer(shape).IsValid(); }

// Outward unit normal (orientation applied) and a point of `face` at the middle of its parameter box.
void outward_frame(const TopoDS_Face &face, gp_Pnt &point, gp_Dir &normal) {
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  gp_Vec vector;
  BRepGProp_Face(face).Normal((u0 + u1) / 2, (v0 + v1) / 2, point, vector);
  normal = gp_Dir(vector);
}

// +1 when a positive offset moves the face along its outward normal, -1 against it. Planes and free-form faces: along the outward normal. Cylinder,
// cone, sphere, torus: AWAY from the axis / centre, so a boss thickens and a bore widens for a positive distance.
double offset_sign(const TopoDS_Face &face) {
  const BRepAdaptor_Surface surface(face, Standard_True);
  gp_Pnt point;
  gp_Dir normal;
  outward_frame(face, point, normal);
  gp_Vec radial;
  switch (surface.GetType()) {
    case GeomAbs_Cylinder:
    case GeomAbs_Cone: {
      const gp_Ax1 axis = surface.GetType() == GeomAbs_Cylinder ? surface.Cylinder().Axis() : surface.Cone().Axis();
      const gp_Vec along(axis.Direction());
      const gp_Vec from(axis.Location(), point);
      radial = from - along * from.Dot(along);
      break;
    }
    case GeomAbs_Sphere:
      radial = gp_Vec(surface.Sphere().Location(), point);
      break;
    case GeomAbs_Torus: {
      const gp_Torus torus = surface.Torus();
      const gp_Vec from(torus.Location(), point);
      const gp_Vec along(torus.Axis().Direction());
      const gp_Vec flat = from - along * from.Dot(along);
      radial = flat.Magnitude() > 1e-12 ? from - flat.Normalized() * torus.MajorRadius() : from;
      break;
    }
    default:
      return 1.0;
  }
  return radial.Magnitude() > 1e-12 && radial.Dot(gp_Vec(normal)) < 0 ? -1.0 : 1.0;
}

std::unique_ptr<Shape> defeature(const Shape &shape, const std::vector<TopoDS_Face> &picked) {
  BRepAlgoAPI_Defeaturing algorithm;
  algorithm.SetShape(shape.shape);
  for (const TopoDS_Face &face : picked) algorithm.AddFaceToRemove(face);
  algorithm.SetRunParallel(Standard_False);
  algorithm.SetToFillHistory(Standard_True);
  algorithm.Build();
  if (!algorithm.IsDone() || algorithm.HasErrors() || algorithm.Shape().IsNull()) return nullptr;
  // OCC reports success and leaves a face it could not remove: that is a refusal, not a silent no-op
  for (const TopoDS_Face &face : picked)
    if (!algorithm.IsDeleted(face)) return nullptr;
  const TopoDS_Shape result = single_solid(algorithm.Shape());
  if (!sound(result)) return nullptr;
  const std::vector<naming::Named> inputs{naming::named(shape)};
  return naming::wrap_named(result, naming::inherit(result, inputs, algorithm.History(), "defeature"));
}

// Offsets `picked` by `distance` (see offset_sign): BRepOffset_MakeOffset of the whole solid with a zero global offset and a per-face offset, the
// intersection join, so the neighbours of a moved face extend or shrink to meet it (drafted and obtuse neighbours, adjacent picked faces and fillet
// faces included). OCC answers the closed shell of the result; it is made a solid and must be valid with a positive volume.
std::unique_ptr<Shape> offset_faces(const Shape &shape, const std::vector<TopoDS_Face> &picked, double distance) {
  BRepOffset_MakeOffset maker;
  maker.Initialize(shape.shape, 0.0, kOffsetTolerance, BRepOffset_Skin, Standard_True, Standard_False, GeomAbs_Intersection, Standard_False,
                   Standard_False);
  for (const TopoDS_Face &face : picked) maker.SetOffsetOnFace(face, offset_sign(face) * distance);
  maker.MakeOffsetShape();
  if (!maker.IsDone() || maker.Shape().IsNull()) return nullptr;
  TopoDS_Shape result = single_solid(maker.Shape());
  if (result.IsNull()) {
    TopTools_IndexedMapOfShape shells;
    TopExp::MapShapes(maker.Shape(), TopAbs_SHELL, shells);
    if (shells.Extent() != 1) return nullptr;
    result = ShapeFix_Solid().SolidFromShell(TopoDS::Shell(shells(1)));
  }
  if (!sound(result) || volume_of(result) <= 0) return nullptr;
  const std::vector<naming::Named> inputs{naming::named(shape)};
  return naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), "offset"));
}

// Moves the FEATURE made of `picked`: defeature it away, then cut back / fuse the removed / added volume moved by `motion`.
std::unique_ptr<Shape> move_feature(const Shape &shape, const std::vector<TopoDS_Face> &picked, const gp_Trsf &motion) {
  std::unique_ptr<Shape> current = defeature(shape, picked);
  if (!current) return nullptr;
  const double significant = kNegligibleVolume * std::max(volume_of(shape.shape), 1.0);
  std::unique_ptr<Shape> removed = boolean_op(*current, shape, 1, false);
  std::unique_ptr<Shape> added = boolean_op(shape, *current, 1, false);
  if (!removed || !added) return nullptr;
  // the moved copy keeps the face names of the tool through the transform's own history, so the moved wall is still the picked face
  const auto moved = [&motion](const Shape &tool) {
    BRepBuilderAPI_Transform transform(tool.shape, motion, Standard_True);
    const std::vector<naming::Named> inputs{naming::named(tool)};
    Shape result(transform.Shape());
    result.names = naming::inherit(result.shape, inputs, naming::history_of(inputs, transform), "move");
    return result;
  };
  const bool has_removed = volume_of(removed->shape) > significant;
  const bool has_added = volume_of(added->shape) > significant;
  if (!has_removed && !has_added) return nullptr;
  if (has_removed) {
    current = boolean_op(*current, moved(*removed), 1, true);
    if (!current) return nullptr;
  }
  if (has_added) {
    current = boolean_op(*current, moved(*added), 0, true);
    if (!current) return nullptr;
  }
  return sound(current->shape) ? std::move(current) : nullptr;
}

// A planar face's outward normal and a point on it, or false for any other face.
bool planar_frame(const TopoDS_Face &face, gp_Pnt &point, gp_Dir &normal) {
  if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) return false;
  outward_frame(face, point, normal);
  return true;
}

// Rotates the plane of one planar face about `axis` by `angle`: the new plane is all that matters (the neighbours extend), and it is the old plane
// drafted about their common line, so DraftAngle does it. The sign of the draft angle is the one whose result has a face on the new plane.
std::unique_ptr<Shape> rotate_planar_face(const Shape &shape, uint32_t index, const gp_Ax1 &axis, double angle) {
  const TopoDS_Face face = picked_faces(shape.shape, rust::Slice<const uint32_t>(&index, 1)).at(0);
  gp_Pnt p0;
  gp_Dir n;
  if (!planar_frame(face, p0, n)) return nullptr;
  gp_Trsf rotation;
  rotation.SetRotation(axis, angle);
  const gp_Dir n2 = n.Transformed(rotation);
  const gp_Pnt q0 = p0.Transformed(rotation);
  const gp_Vec line = gp_Vec(n).Crossed(gp_Vec(n2));
  const double dihedral = std::asin(std::min(1.0, line.Magnitude()));
  if (line.Magnitude() < 1e-9 || dihedral >= 1.5) return nullptr;  // same / opposite plane, or a draft beyond DraftAngle's range
  const gp_Dir e(line);
  // a point x0 of the line P n P': n.(x - p0) = 0, n2.(x - q0) = 0, e.(x - p0) = 0
  const double d1 = gp_Vec(n).Dot(gp_Vec(gp_Pnt(0, 0, 0), p0));
  const double d2 = gp_Vec(n2).Dot(gp_Vec(gp_Pnt(0, 0, 0), q0));
  const double d3 = gp_Vec(e).Dot(gp_Vec(gp_Pnt(0, 0, 0), p0));
  const gp_Vec cross23 = gp_Vec(n2).Crossed(gp_Vec(e));
  const gp_Vec cross31 = gp_Vec(e).Crossed(gp_Vec(n));
  const gp_Vec cross12 = gp_Vec(n).Crossed(gp_Vec(n2));
  const double determinant = gp_Vec(n).Dot(cross23);
  const gp_Vec solved = (cross23 * d1 + cross31 * d2 + cross12 * d3) / determinant;
  const gp_Pnt x0(solved.X(), solved.Y(), solved.Z());
  const gp_Dir pull(gp_Vec(n).Crossed(gp_Vec(e)));
  const gp_Pln neutral(x0, pull);
  for (double sign : {1.0, -1.0}) {
    BRepOffsetAPI_DraftAngle maker(shape.shape);
    maker.Add(face, pull, sign * dihedral, neutral, Standard_True);
    if (!maker.AddDone()) continue;
    maker.Build();
    if (!maker.IsDone()) continue;
    const TopoDS_Shape result = single_solid(maker.Shape());
    if (!sound(result)) continue;
    // the drafted face lies on the new plane
    const TopTools_IndexedMapOfShape faces = faces_of(result);
    bool on_plane = false;
    for (int k = 1; k <= faces.Extent() && !on_plane; ++k) {
      gp_Pnt point;
      gp_Dir normal;
      if (planar_frame(TopoDS::Face(faces(k)), point, normal))
        on_plane = normal.Dot(n2) > 1 - 1e-6 && std::abs(gp_Vec(point, x0).Dot(gp_Vec(n2))) < 1e-5 * (1 + gp_Vec(gp_Pnt(0, 0, 0), x0).Magnitude());
    }
    if (!on_plane) continue;
    const std::vector<naming::Named> inputs{naming::named(shape)};
    return naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, maker), "move"));
  }
  return nullptr;
}

}  // namespace

std::unique_ptr<Shape> delete_faces(const Shape &shape, rust::Slice<const uint32_t> faces) {
  const std::vector<TopoDS_Face> picked = picked_faces(shape.shape, faces);
  if (picked.empty() || picked.size() != faces.size()) return nullptr;
  return defeature(shape, picked);
}

std::unique_ptr<Shape> move_faces(const Shape &shape, rust::Slice<const uint32_t> faces, int32_t mode, rust::Slice<const double> a,
                                  rust::Slice<const double> b, double value) {
  const std::vector<TopoDS_Face> picked = picked_faces(shape.shape, faces);
  if (picked.empty() || picked.size() != faces.size() || !std::isfinite(value)) return nullptr;
  if (mode == 0) return value == 0 ? nullptr : offset_faces(shape, picked, value);
  if (mode == 1) {
    if (a.size() != 3) throw std::invalid_argument("move_faces: translate needs a 3-component vector");
    const gp_Vec vector(a[0], a[1], a[2]);
    if (vector.Magnitude() < 1e-12) return nullptr;
    if (picked.size() == 1) {
      gp_Pnt point;
      gp_Dir normal;
      if (planar_frame(picked[0], point, normal)) {
        const double distance = vector.Dot(gp_Vec(normal));
        // the plane moves by the normal component only; the in-plane part changes nothing
        return std::abs(distance) < 1e-9 ? nullptr : push_pull(shape, faces[0], distance);
      }
    }
    gp_Trsf motion;
    motion.SetTranslation(vector);
    return move_feature(shape, picked, motion);
  }
  if (mode == 2) {
    if (a.size() != 3 || b.size() != 3) throw std::invalid_argument("move_faces: rotate needs an axis origin and direction");
    const gp_Vec direction(b[0], b[1], b[2]);
    if (direction.Magnitude() < 1e-12 || std::abs(value) < 1e-12) return nullptr;
    const gp_Ax1 axis(gp_Pnt(a[0], a[1], a[2]), gp_Dir(direction));
    if (picked.size() == 1) {
      gp_Pnt point;
      gp_Dir normal;
      if (planar_frame(picked[0], point, normal)) return rotate_planar_face(shape, faces[0], axis, value);
    }
    gp_Trsf motion;
    motion.SetRotation(axis, value);
    return move_feature(shape, picked, motion);
  }
  throw std::invalid_argument("move_faces: unknown mode");
}

}  // namespace llull

// OCCT side of the llull native kernel facade. Each maker follows the builders of the retired opencascade.js kernel (VC-KRN-25): same
// builders, same placement order, same post-boolean unify.
#include "llull-kernel-occt/cpp/facade.hxx"

#include <cmath>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Writer.hxx>
#include <ShapeAnalysis_ShapeContents.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Version.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Ax1.hxx>
#include <gp_Trsf.hxx>

#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/src/lib.rs.h"

namespace llull {

namespace {

using naming::Named;

void require_length(rust::Slice<const double> values, size_t length, const char *what) {
  if (values.size() != length) throw std::invalid_argument(std::string(what) + ": wrong number of components");
}

std::unique_ptr<Shape> wrap(const TopoDS_Shape &shape) {
  if (shape.IsNull()) return nullptr;
  return std::make_unique<Shape>(shape);
}

// Closed planar polygon face through `polygon` (x, y, z triples); null shape when OCC rejects the wire or the face.
TopoDS_Shape polygon_face(rust::Slice<const double> polygon) {
  if (polygon.size() < 9 || polygon.size() % 3 != 0) throw std::invalid_argument("polygon: need >= 3 points");
  BRepBuilderAPI_MakePolygon wire;
  for (size_t i = 0; i < polygon.size(); i += 3) wire.Add(gp_Pnt(polygon[i], polygon[i + 1], polygon[i + 2]));
  wire.Close();
  if (!wire.IsDone()) return TopoDS_Shape();
  BRepBuilderAPI_MakeFace face(wire.Wire(), Standard_False);
  return face.IsDone() ? TopoDS_Shape(face.Face()) : TopoDS_Shape();
}

// llull placement M = T · Rx · Ry · Rz · anchorShift (packages/kernel-occt/src/occtShapes.ts placementTransform).
gp_Trsf placement(rust::Slice<const double> rotation, rust::Slice<const double> position, rust::Slice<const double> anchor_shift) {
  require_length(rotation, 3, "rotation");
  require_length(position, 3, "position");
  require_length(anchor_shift, 3, "anchor shift");
  gp_Trsf total;
  total.SetTranslation(gp_Vec(position[0], position[1], position[2]));
  const double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (int k = 0; k < 3; ++k) {
    gp_Trsf turn;
    turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(axes[k][0], axes[k][1], axes[k][2])), rotation[k]);
    total.Multiply(turn);
  }
  if (anchor_shift[0] != 0 || anchor_shift[1] != 0 || anchor_shift[2] != 0) {
    gp_Trsf local;
    local.SetTranslation(gp_Vec(anchor_shift[0], anchor_shift[1], anchor_shift[2]));
    total.Multiply(local);
  }
  return total;
}

TopoDS_Shape transformed_copy(const TopoDS_Shape &shape, const gp_Trsf &transform) {
  BRepBuilderAPI_Transform transformer(shape, transform, Standard_True);
  return transformer.Shape();
}

// A transformed copy that keeps the face names (the copy's faces are the history images of the original's).
std::unique_ptr<Shape> transformed_named(const Shape &shape, const gp_Trsf &transform) {
  BRepBuilderAPI_Transform transformer(shape.shape, transform, Standard_True);
  const std::vector<Named> inputs{naming::named(shape)};
  const TopoDS_Shape result = transformer.Shape();
  return naming::wrap_named(result, naming::inherit(result, inputs, naming::history_of(inputs, transformer), "transform"));
}

std::unique_ptr<Shape> with_roles(const TopoDS_Shape &shape, bool axial) {
  return naming::wrap_named(shape, naming::primitive_roles(shape, axial));
}

// Tight box from the exact geometry: BRepBndLib::Add bounds curved faces by their control polygons and widens by the tolerances.
Bnd_Box bounds_of(const TopoDS_Shape &shape) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
  return box;
}

void push_bounds(rust::Vec<double> &out, const Bnd_Box &box) {
  const gp_Pnt min = box.CornerMin();
  const gp_Pnt max = box.CornerMax();
  for (double value : {min.X(), min.Y(), min.Z(), max.X(), max.Y(), max.Z()}) out.push_back(value);
}

bool is_closed_solid(const TopoDS_Shape &shape) {
  TopExp_Explorer solids(shape, TopAbs_SOLID);
  TopExp_Explorer free_faces(shape, TopAbs_FACE, TopAbs_SOLID);
  return solids.More() && !free_faces.More();
}

}  // namespace

void init_runtime() {
  // stdout carries the NDJSON protocol: OCCT's default printer and any std::cout chatter go to stderr instead.
  Message::DefaultMessenger()->RemovePrinters(STANDARD_TYPE(Message_PrinterOStream));
  std::cout.rdbuf(std::cerr.rdbuf());
}

rust::String occt_version() { return rust::String(OCC_VERSION_COMPLETE); }

std::unique_ptr<Shape> make_box(rust::Slice<const double> origin, rust::Slice<const double> size) {
  require_length(origin, 3, "origin");
  require_length(size, 3, "size");
  BRepPrimAPI_MakeBox maker(gp_Pnt(origin[0], origin[1], origin[2]), size[0], size[1], size[2]);
  return with_roles(maker.Shape(), false);
}

std::unique_ptr<Shape> make_cylinder(double radius, double height) {
  BRepPrimAPI_MakeCylinder maker(radius, height);
  return with_roles(maker.Shape(), true);
}

std::unique_ptr<Shape> make_sphere(double radius) {
  BRepPrimAPI_MakeSphere maker(radius);
  return with_roles(maker.Shape(), true);
}

std::unique_ptr<Shape> make_cone(double base_radius, double top_radius, double height) {
  BRepPrimAPI_MakeCone maker(base_radius, top_radius, height);
  return with_roles(maker.Shape(), true);
}

std::unique_ptr<Shape> make_torus(double ring_radius, double tube_radius) {
  BRepPrimAPI_MakeTorus maker(ring_radius, tube_radius);
  return with_roles(maker.Shape(), true);
}

std::unique_ptr<Shape> make_prism(rust::Slice<const double> polygon, rust::Slice<const double> direction) {
  require_length(direction, 3, "direction");
  const TopoDS_Shape face = polygon_face(polygon);
  if (face.IsNull()) return nullptr;
  BRepPrimAPI_MakePrism maker(face, gp_Vec(direction[0], direction[1], direction[2]), Standard_False, Standard_True);
  const TopoDS_Shape result = maker.Shape();
  return naming::wrap_named(result, naming::swept_roles(result, face, maker, "side"));
}

std::unique_ptr<Shape> make_revolution(rust::Slice<const double> polygon, rust::Slice<const double> axis, double angle) {
  require_length(axis, 3, "axis");
  const TopoDS_Shape face = polygon_face(polygon);
  if (face.IsNull()) return nullptr;
  BRepPrimAPI_MakeRevol maker(face, gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(axis[0], axis[1], axis[2])), angle, Standard_False);
  const TopoDS_Shape result = maker.Shape();
  return naming::wrap_named(result, naming::swept_roles(result, face, maker, "section"));
}

std::unique_ptr<Shape> make_sewn_solid(rust::Slice<const double> positions, rust::Slice<const uint32_t> indices) {
  if (positions.size() % 3 != 0 || indices.size() % 3 != 0 || indices.empty()) return nullptr;
  const size_t vertex_count = positions.size() / 3;
  BRepBuilderAPI_Sewing sewing(1e-6, Standard_True, Standard_True, Standard_True, Standard_False);
  for (size_t t = 0; t < indices.size(); t += 3) {
    double corners[9];
    for (int k = 0; k < 3; ++k) {
      const size_t vertex = indices[t + k];
      if (vertex >= vertex_count) return nullptr;
      for (int axis = 0; axis < 3; ++axis) corners[k * 3 + axis] = positions[vertex * 3 + axis];
    }
    const gp_Vec u(corners[3] - corners[0], corners[4] - corners[1], corners[5] - corners[2]);
    const gp_Vec v(corners[6] - corners[0], corners[7] - corners[1], corners[8] - corners[2]);
    if (u.Crossed(v).SquareMagnitude() < 1e-24) continue;
    const TopoDS_Shape face = polygon_face(rust::Slice<const double>(corners, 9));
    if (!face.IsNull()) sewing.Add(face);
  }
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) return nullptr;
  BRepBuilderAPI_MakeSolid solid;
  int shells = 0;
  for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
    solid.Add(TopoDS::Shell(shell.Current()));
    ++shells;
  }
  if (shells == 0) return nullptr;
  solid.Build();
  return solid.IsDone() ? wrap(solid.Shape()) : nullptr;
}

std::unique_ptr<Shape> placed(const Shape &shape, rust::Slice<const double> rotation, rust::Slice<const double> position,
                              rust::Slice<const double> anchor_shift) {
  return transformed_named(shape, placement(rotation, position, anchor_shift));
}

std::unique_ptr<Shape> scaled(const Shape &shape, double factor) {
  gp_Trsf transform;
  transform.SetScale(gp_Pnt(0, 0, 0), factor);
  return transformed_named(shape, transform);
}

namespace {

template <class Builder>
bool run_boolean(Builder &builder, TopoDS_Shape &result, Handle(BRepTools_History) & history) {
  if (!builder.IsDone()) return false;
  result = builder.Shape();
  history = builder.History();
  return true;
}

}  // namespace

std::unique_ptr<Shape> boolean_op(const Shape &a, const Shape &b, int32_t operation, bool unify) {
  TopoDS_Shape result;
  Handle(BRepTools_History) history;
  bool done = false;
  if (operation == 0) {
    BRepAlgoAPI_Fuse builder(a.shape, b.shape);
    done = run_boolean(builder, result, history);
  } else if (operation == 1) {
    BRepAlgoAPI_Cut builder(a.shape, b.shape);
    done = run_boolean(builder, result, history);
  } else if (operation == 2) {
    BRepAlgoAPI_Common builder(a.shape, b.shape);
    done = run_boolean(builder, result, history);
  } else {
    throw std::invalid_argument("boolean: unknown operation");
  }
  if (!done) return nullptr;
  const std::vector<Named> inputs{naming::named(a), naming::named(b)};
  std::vector<std::string> names = naming::inherit(result, inputs, history, "boolean");
  if (unify) {
    try {
      // Merge the faces a boolean split so face / edge indices stay stable for later fillets.
      ShapeUpgrade_UnifySameDomain unifier(result, Standard_True, Standard_True, Standard_False);
      unifier.AllowInternalEdges(Standard_False);
      unifier.Build();
      const TopoDS_Shape unified = unifier.Shape();
      const std::vector<Named> split{Named{result, names}};
      return naming::wrap_named(unified, naming::inherit(unified, split, unifier.History(), "unify"));
    } catch (const Standard_Failure &) {
      // fall through: the boolean result itself
    }
  }
  return naming::wrap_named(result, std::move(names));
}

std::unique_ptr<Shape> prefixed(const Shape &shape, rust::Str prefix) {
  std::vector<std::string> names = naming::face_names(shape);
  const std::string head = std::string(prefix) + ":";
  for (std::string &name : names) name = head + name;
  return naming::wrap_named(shape.shape, std::move(names));
}

MeshOut tessellate(const Shape &shape, double linear_deflection, double angular_deflection) {
  BRepMesh_IncrementalMesh mesher(shape.shape, linear_deflection, Standard_False, angular_deflection, Standard_False);
  MeshOut out;
  out.missing_faces = 0;
  out.closed_solid = is_closed_solid(shape.shape);
  uint32_t offset = 0;
  for (TopExp_Explorer explorer(shape.shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    TopLoc_Location location;
    const Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(face, location);
    if (triangulation.IsNull()) {
      ++out.missing_faces;
      continue;
    }
    const gp_Trsf transform = location.Transformation();
    const int nodes = triangulation->NbNodes();
    for (int i = 1; i <= nodes; ++i) {
      const gp_Pnt node = triangulation->Node(i).Transformed(transform);
      out.positions.push_back(node.X());
      out.positions.push_back(node.Y());
      out.positions.push_back(node.Z());
    }
    // A REVERSED face's stored triangles wind against the solid's outward normal: flip them.
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    for (int i = 1; i <= triangulation->NbTriangles(); ++i) {
      int first = 0, second = 0, third = 0;
      triangulation->Triangle(i).Get(first, second, third);
      out.indices.push_back(offset + static_cast<uint32_t>(first) - 1);
      out.indices.push_back(offset + static_cast<uint32_t>(reversed ? third : second) - 1);
      out.indices.push_back(offset + static_cast<uint32_t>(reversed ? second : third) - 1);
    }
    offset += static_cast<uint32_t>(nodes);
  }
  return out;
}

MassOut mass_properties(const Shape &shape) {
  // Part frame (TR-KRN-41): integrate about the bounding-box centre rounded to 1 mm, then shift the centroid back.
  const Bnd_Box box = bounds_of(shape.shape);
  const gp_Pnt min = box.CornerMin();
  const gp_Pnt max = box.CornerMax();
  const double origin[3] = {std::round((min.X() + max.X()) / 2) + 0.0, std::round((min.Y() + max.Y()) / 2) + 0.0,
                            std::round((min.Z() + max.Z()) / 2) + 0.0};
  TopoDS_Shape local = shape.shape;
  if (origin[0] != 0 || origin[1] != 0 || origin[2] != 0) {
    gp_Trsf shift;
    shift.SetTranslation(gp_Vec(-origin[0], -origin[1], -origin[2]));
    local = transformed_copy(shape.shape, shift);
  }
  GProp_GProps volume;
  GProp_GProps surface;
  MassOut out;
  // Default (Gauss) rule, as the OCP 7.9.3 reference of VC-KRN-25: the adaptive Eps rule drifts on toroidal and some freeform faces
  // (up to 1.6e-6 relative volume, Ixx != Iyy on a symmetric ring, on the NIST corpus) while its error estimate stays near 1e-15.
  BRepGProp::VolumeProperties(local, volume, Standard_True, Standard_False, Standard_False);
  out.rel_error = std::numeric_limits<double>::quiet_NaN();
  BRepGProp::SurfaceProperties(local, surface, Standard_False, Standard_False);
  const double signed_volume = volume.Mass();
  out.volume = std::fabs(signed_volume);
  out.area = surface.Mass();
  const double sign = signed_volume < 0 ? -1.0 : 1.0;
  const gp_Pnt centre = volume.CentreOfMass();
  for (double value : {centre.X() + origin[0], centre.Y() + origin[1], centre.Z() + origin[2]}) out.centroid.push_back(value);
  const gp_Mat inertia = volume.MatrixOfInertia();
  for (const auto &cell : {std::pair<int, int>{1, 1}, {2, 2}, {3, 3}, {1, 2}, {1, 3}, {2, 3}})
    out.inertia.push_back(sign * inertia.Value(cell.first, cell.second));
  push_bounds(out.bounds, box);
  return out;
}

AnalysisOut analyze(const Shape &shape) {
  AnalysisOut out;
  BRepCheck_Analyzer checker(shape.shape, Standard_True);
  out.valid = checker.IsValid();
  ShapeAnalysis_ShapeContents contents;
  contents.Perform(shape.shape);
  out.free_faces = contents.NbFreeFaces();
  out.free_edges = contents.NbFreeEdges();
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(shape.shape, TopAbs_SOLID, solids);
  out.solids = solids.Extent();
  for (int i = 1; i <= solids.Extent(); ++i) {
    GProp_GProps volume;
    GProp_GProps area;
    BRepGProp::VolumeProperties(solids(i), volume, Standard_False, Standard_False, Standard_False);
    BRepGProp::SurfaceProperties(solids(i), area, Standard_False, Standard_False);
    out.lumps.push_back(std::fabs(volume.Mass()));
    out.lumps.push_back(area.Mass());
    push_bounds(out.lumps, bounds_of(solids(i)));
  }
  GProp_GProps total;
  BRepGProp::SurfaceProperties(shape.shape, total, Standard_False, Standard_False);
  out.area = total.Mass();
  return out;
}

std::unique_ptr<StepWriter> new_step_writer() { return std::make_unique<StepWriter>(); }

bool step_add(StepWriter &writer, const Shape &shape) {
  return writer.writer.Transfer(shape.shape, STEPControl_AsIs, Standard_True) == IFSelect_RetDone;
}

rust::String step_finish(StepWriter &writer) {
  std::ostringstream text;
  if (writer.writer.WriteStream(text) != IFSelect_RetDone) throw std::runtime_error("STEP write not done");
  return rust::String(text.str());
}

}  // namespace llull

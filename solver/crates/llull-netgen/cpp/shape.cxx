// Shapes for llull-mesh: STEP import, planar mid faces, fragmentation (conformal bonding), defeaturing, and the B-rep queries the
// mesher resolves targets with (trimmed distances, areas, centroids, local-size sample points). Numbering follows Netgen's maps.
#include <mystdlib.h>
#include <myadt.hpp>
#include <occgeom.hpp>

#include <BOPAlgo_Builder.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Reader.hxx>
#include <ShapeFix_Face.hxx>
#include <Standard_Version.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Trsf.hxx>

#include <algorithm>
#include <cmath>
#include <sstream>
#include <stdexcept>

#include "llull-netgen/cpp/facade.hxx"
#include "llull-netgen/cpp/quiet.hxx"
#include "llull-netgen/src/lib.rs.h"

namespace llull_netgen {

namespace {

// Beyond this many sample points a local size is spread more thinly (the octree restriction stays bounded).
constexpr double MAX_SAMPLES = 400000.0;

const TopoDS_Shape &item(const TopTools_IndexedMapOfShape &map, int32_t index, const char *what) {
  if (index < 1 || index > map.Extent()) throw std::out_of_range(std::string(what) + " " + std::to_string(index) + " does not exist");
  return map(index);
}

rust::Vec<int32_t> sorted(std::vector<int32_t> values) {
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  rust::Vec<int32_t> out;
  for (int32_t value : values) out.push_back(value);
  return out;
}

// The distance between a point and a shape, then the closest point on the shape.
BRepExtrema_DistShapeShape nearest(const TopoDS_Shape &target, double x, double y, double z) {
  BRepExtrema_DistShapeShape distance(BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, z)).Vertex(), target);
  if (!distance.IsDone() || distance.NbSolution() == 0) throw std::runtime_error("OCCT found no distance to the shape");
  return distance;
}

void push_point(rust::Vec<double> &out, const gp_XYZ &point) {
  out.push_back(point.X());
  out.push_back(point.Y());
  out.push_back(point.Z());
}

// The pieces of `input` in a general-fuse result: what it was split into, or itself when untouched.
std::vector<TopoDS_Shape> pieces_of(BOPAlgo_Builder &builder, const TopoDS_Shape &input) {
  std::vector<TopoDS_Shape> pieces;
  for (const TopoDS_Shape &piece : builder.Modified(input)) pieces.push_back(piece);
  if (pieces.empty() && !builder.IsDeleted(input)) pieces.push_back(input);
  return pieces;
}

std::unique_ptr<Shape> fused(const std::vector<TopoDS_Shape> &arguments, const std::vector<int32_t> &owner_of, double fuzzy,
                             TopAbs_ShapeEnum kind) {
  BOPAlgo_Builder builder;
  for (const TopoDS_Shape &argument : arguments) builder.AddArgument(argument);
  builder.SetRunParallel(false);
  builder.SetNonDestructive(true);
  if (fuzzy > 0.0) builder.SetFuzzyValue(fuzzy);
  builder.Perform();
  if (builder.HasErrors()) {
    std::ostringstream report;
    builder.DumpErrors(report);
    throw std::runtime_error("OCCT could not fragment the shapes: " + report.str());
  }
  auto out = std::make_unique<Shape>(builder.Shape());
  const auto &map = kind == TopAbs_SOLID ? out->geometry->somap : out->geometry->fmap;
  out->owner_lists.resize(map.Extent());
  for (size_t i = 0; i < arguments.size(); ++i)
    for (const TopoDS_Shape &piece : pieces_of(builder, arguments[i])) {
      const int index = map.FindIndex(piece);
      if (index < 1) continue;
      auto &owners = out->owner_lists[index - 1];
      if (std::find(owners.begin(), owners.end(), owner_of[i]) == owners.end()) owners.push_back(owner_of[i]);
    }
  return out;
}

}  // namespace

Shape::Shape(const TopoDS_Shape &value) : shape(value) {
  Quiet quiet;
  geometry = std::make_shared<netgen::OCCGeometry>(shape, 3);
}

Shape::~Shape() = default;

int32_t Shape::solid_count() const { return geometry->somap.Extent(); }
int32_t Shape::face_count() const { return geometry->fmap.Extent(); }
int32_t Shape::edge_count() const { return geometry->emap.Extent(); }

rust::Vec<int32_t> Shape::solid_faces(int32_t solid) const {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(item(geometry->somap, solid, "solid"), TopAbs_FACE, faces);
  std::vector<int32_t> out;
  for (int i = 1; i <= faces.Extent(); ++i) out.push_back(geometry->fmap.FindIndex(faces(i)));
  return sorted(out);
}

rust::Vec<int32_t> Shape::face_edges(int32_t face) const {
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes(item(geometry->fmap, face, "face"), TopAbs_EDGE, edges);
  std::vector<int32_t> out;
  for (int i = 1; i <= edges.Extent(); ++i)
    if (!BRep_Tool::Degenerated(TopoDS::Edge(edges(i)))) out.push_back(geometry->emap.FindIndex(edges(i)));
  return sorted(out);
}

rust::Vec<int32_t> Shape::owners(int32_t index) const {
  rust::Vec<int32_t> out;
  if (index >= 1 && static_cast<size_t>(index) <= owner_lists.size())
    for (int32_t owner : owner_lists[index - 1]) out.push_back(owner);
  return out;
}

rust::Vec<double> Shape::bounds() const {
  Bnd_Box box;
  BRepBndLib::AddOptimal(shape, box, false, false);
  rust::Vec<double> out;
  if (box.IsVoid()) {
    for (int i = 0; i < 6; ++i) out.push_back(0.0);
    return out;
  }
  double values[6];
  box.Get(values[0], values[1], values[2], values[3], values[4], values[5]);
  for (double value : values) out.push_back(value);
  return out;
}

double Shape::face_area(int32_t face) const {
  GProp_GProps properties;
  BRepGProp::SurfaceProperties(item(geometry->fmap, face, "face"), properties);
  return properties.Mass();
}

rust::Vec<double> Shape::face_centroid(int32_t face) const {
  GProp_GProps properties;
  BRepGProp::SurfaceProperties(item(geometry->fmap, face, "face"), properties);
  rust::Vec<double> out;
  push_point(out, properties.CentreOfMass().XYZ());
  return out;
}

rust::Vec<double> Shape::face_distance(int32_t face, double x, double y, double z) const {
  const auto distance = nearest(item(geometry->fmap, face, "face"), x, y, z);
  rust::Vec<double> out;
  out.push_back(distance.Value());
  push_point(out, distance.PointOnShape2(1).XYZ());
  return out;
}

double Shape::edge_distance(int32_t edge, double x, double y, double z) const {
  return nearest(item(geometry->emap, edge, "edge"), x, y, z).Value();
}

double Shape::face_radius(int32_t face) const {
  BRepAdaptor_Surface surface(TopoDS::Face(item(geometry->fmap, face, "face")));
  switch (surface.GetType()) {
    case GeomAbs_Cylinder:
      return surface.Cylinder().Radius();
    case GeomAbs_Torus:
      return surface.Torus().MinorRadius();
    default:
      return 0.0;
  }
}

rust::Vec<double> Shape::sample_face(int32_t face, double spacing) const {
  // a copy, so the sampling triangulation never reaches the faces Netgen meshes
  const TopoDS_Face copy = TopoDS::Face(BRepBuilderAPI_Copy(item(geometry->fmap, face, "face")).Shape());
  GProp_GProps properties;
  BRepGProp::SurfaceProperties(copy, properties);
  const double step = std::max(spacing, std::sqrt(2.0 * properties.Mass() / MAX_SAMPLES));
  BRepMesh_IncrementalMesh(copy, step / 4.0, false, 0.5);
  TopLoc_Location location;
  const Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(copy, location);
  rust::Vec<double> out;
  if (triangulation.IsNull()) return out;
  for (int t = 1; t <= triangulation->NbTriangles(); ++t) {
    int a, b, c;
    triangulation->Triangle(t).Get(a, b, c);
    const gp_XYZ p0 = triangulation->Node(a).Transformed(location).XYZ();
    const gp_XYZ p1 = triangulation->Node(b).Transformed(location).XYZ();
    const gp_XYZ p2 = triangulation->Node(c).Transformed(location).XYZ();
    const double longest = std::max({(p1 - p0).Modulus(), (p2 - p1).Modulus(), (p0 - p2).Modulus()});
    const int n = std::max(1, static_cast<int>(std::ceil(longest / step)));
    for (int i = 0; i <= n; ++i)
      for (int j = 0; i + j <= n; ++j) push_point(out, p0 + (p1 - p0) * (double(i) / n) + (p2 - p0) * (double(j) / n));
  }
  return out;
}

rust::Vec<double> Shape::sample_edge(int32_t edge, double spacing) const {
  const TopoDS_Edge &shape_edge = TopoDS::Edge(item(geometry->emap, edge, "edge"));
  rust::Vec<double> out;
  if (BRep_Tool::Degenerated(shape_edge)) return out;
  BRepAdaptor_Curve curve(shape_edge);
  const double length = GCPnts_AbscissaPoint::Length(curve);
  const int n = std::max(1, static_cast<int>(std::ceil(length / std::max(spacing, length / MAX_SAMPLES))));
  for (int i = 0; i <= n; ++i) {
    const double parameter = curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * (double(i) / n);
    push_point(out, curve.Value(parameter).XYZ());
  }
  return out;
}

std::unique_ptr<Shape> Shape::defeatured(rust::Slice<const int32_t> faces) const {
  BRepAlgoAPI_Defeaturing algorithm;
  algorithm.SetShape(shape);
  for (int32_t face : faces) algorithm.AddFaceToRemove(item(geometry->fmap, face, "face"));
  algorithm.SetRunParallel(false);
  algorithm.SetToFillHistory(false);
  algorithm.Build();
  if (!algorithm.IsDone() || algorithm.Shape().IsNull()) {
    std::ostringstream report;
    algorithm.DumpErrors(report);
    throw std::runtime_error("OCCT defeaturing failed: " + report.str());
  }
  return std::make_unique<Shape>(algorithm.Shape());
}

rust::String occt_version() { return rust::String(OCC_VERSION_COMPLETE); }

std::unique_ptr<Shape> read_step(rust::Str path, double scale) {
  Quiet quiet;
  STEPControl_Reader reader;
  if (reader.ReadFile(std::string(path).c_str()) != IFSelect_RetDone) throw std::runtime_error("OCCT could not read the STEP file");
  reader.TransferRoots();
  TopoDS_Shape shape = reader.OneShape();
  if (shape.IsNull()) throw std::runtime_error("the STEP file holds no shape");
  if (scale != 1.0) {
    gp_Trsf transform;
    transform.SetScale(gp_Pnt(0.0, 0.0, 0.0), scale);
    shape = BRepBuilderAPI_Transform(shape, transform, true).Shape();
  }
  return std::make_unique<Shape>(shape);
}

std::unique_ptr<Shape> planar_faces(rust::Slice<const double> coords, rust::Slice<const uint32_t> loop_sizes,
                                    rust::Slice<const uint32_t> face_loops, double fuzzy) {
  std::vector<TopoDS_Shape> faces;
  std::vector<int32_t> owner_of;
  size_t vertex = 0, loop = 0;
  for (size_t f = 0; f < face_loops.size(); ++f) {
    TopoDS_Face face;
    for (uint32_t l = 0; l < face_loops[f]; ++l) {
      if (loop >= loop_sizes.size()) throw std::invalid_argument("planar_faces: more loops than loop sizes");
      const uint32_t count = loop_sizes[loop++];
      if (count < 3 || 3 * (vertex + count) > coords.size()) throw std::invalid_argument("planar_faces: a loop needs 3 or more points");
      BRepBuilderAPI_MakePolygon polygon;
      for (uint32_t k = 0; k < count; ++k, ++vertex)
        polygon.Add(gp_Pnt(coords[3 * vertex], coords[3 * vertex + 1], coords[3 * vertex + 2]));
      polygon.Close();
      if (!polygon.IsDone()) throw std::runtime_error("OCCT could not build a face loop");
      if (l == 0) {
        BRepBuilderAPI_MakeFace maker(polygon.Wire(), true);
        if (!maker.IsDone()) throw std::runtime_error("a mid face is not planar");
        face = maker.Face();
      } else {
        BRepBuilderAPI_MakeFace maker(face, polygon.Wire());
        if (!maker.IsDone()) throw std::runtime_error("OCCT could not add a hole to a mid face");
        face = maker.Face();
      }
    }
    ShapeFix_Face fix(face);
    fix.FixOrientation();
    fix.Perform();
    faces.push_back(fix.Face());
    owner_of.push_back(static_cast<int32_t>(f));
  }
  if (faces.empty()) throw std::invalid_argument("planar_faces: no face");
  Quiet quiet;
  if (faces.size() > 1) return fused(faces, owner_of, fuzzy, TopAbs_FACE);
  auto out = std::make_unique<Shape>(faces[0]);
  out->owner_lists = {{0}};
  return out;
}

std::unique_ptr<ShapeList> new_shape_list() { return std::make_unique<ShapeList>(); }

void push_shape(ShapeList &list, const Shape &shape) { list.shapes.push_back(shape.shape); }

std::unique_ptr<Shape> fragment(const ShapeList &list) {
  std::vector<TopoDS_Shape> solids;
  std::vector<int32_t> owner_of;
  for (size_t i = 0; i < list.shapes.size(); ++i) {
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(list.shapes[i], TopAbs_SOLID, map);
    for (int s = 1; s <= map.Extent(); ++s) {
      solids.push_back(map(s));
      owner_of.push_back(static_cast<int32_t>(i));
    }
  }
  if (solids.empty()) throw std::invalid_argument("fragment: no solid");
  Quiet quiet;
  return fused(solids, owner_of, 0.0, TopAbs_SOLID);
}

}  // namespace llull_netgen

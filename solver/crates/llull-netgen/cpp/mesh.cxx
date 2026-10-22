// Netgen meshing for llull-mesh: OCC shapes (tetrahedra, or faces only) and closed STL surfaces (tetrahedra). Always first order
// and single-threaded (same request, same mesh); llull-mesh adds mid-edge nodes itself. Local sizes: per-face / per-edge maxh
// (Netgen shape properties) and size points (Netgen's local-h octree, graded by params.grading).
#include <mystdlib.h>
#include <myadt.hpp>
#include <meshing.hpp>
#include <occgeom.hpp>
#include <stlgeom.hpp>

#include <netgen_version.hpp>

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

#include "llull-netgen/cpp/facade.hxx"
#include "llull-netgen/cpp/quiet.hxx"
#include "llull-netgen/src/lib.rs.h"

namespace netgen {
// Defined in nglib (stlgeom/stltool.cpp) but declared in no installed header.
DLL_HEADER extern STLParameters stlparam;
}  // namespace netgen

namespace llull_netgen {

namespace {

netgen::MeshingParameters meshing_parameters(const MeshParams &params, const Sizes &sizes) {
  netgen::MeshingParameters mp;
  mp.maxh = params.max_h;
  mp.minh = params.min_h;
  mp.grading = params.grading;
  mp.curvaturesafety = params.curvature_safety;
  mp.segmentsperedge = params.segments_per_edge;
  mp.optsteps3d = params.optimize_steps_3d;
  mp.optsteps2d = params.optimize_steps_2d;
  mp.quad = params.quad_dominated;
  mp.secondorder = false;
  mp.elementorder = 1;
  mp.parallel_meshing = false;
  mp.nthreads = 1;
  if (params.surface_only) mp.perfstepsend = netgen::MESHCONST_OPTSURFACE;
  if (sizes.points.size() % 4 != 0) throw std::invalid_argument("size points are (x, y, z, h) quadruples");
  for (size_t i = 0; i + 3 < sizes.points.size(); i += 4)
    mp.meshsize_points.Append(netgen::MeshingParameters::MeshSizePoint(
        netgen::Point<3>(sizes.points[i], sizes.points[i + 1], sizes.points[i + 2]), sizes.points[i + 3]));
  return mp;
}

MeshData extract(const netgen::Mesh &mesh, bool with_volume) {
  MeshData out;
  const int np = static_cast<int>(mesh.GetNP());
  for (int i = 1; i <= np; ++i) {
    const auto &point = mesh[netgen::PointIndex(i)];
    out.points.push_back(point(0));
    out.points.push_back(point(1));
    out.points.push_back(point(2));
  }
  if (with_volume)
    for (const auto &element : mesh.VolumeElements()) {
      if (element.IsDeleted()) continue;
      if (element.GetType() != netgen::TET) throw std::runtime_error("Netgen produced a volume element that is not a tetrahedron");
      for (int k = 0; k < 4; ++k) out.tets.push_back(static_cast<int32_t>(int(element[k])));
      out.tet_domains.push_back(element.GetIndex());
    }
  for (const auto &element : mesh.SurfaceElements()) {
    if (element.IsDeleted()) continue;
    const int corners = element.GetNP();
    if (corners != 3 && corners != 4) throw std::runtime_error("Netgen produced a surface element with " + std::to_string(corners) + " nodes");
    for (int k = 0; k < 4; ++k) out.surface.push_back(k < corners ? static_cast<int32_t>(int(element[k])) : 0);
    out.surface_faces.push_back(mesh.GetFaceDescriptor(element.GetIndex()).SurfNr());
  }
  for (const auto &segment : mesh.LineSegments()) {
    out.segments.push_back(static_cast<int32_t>(int(segment[0])));
    out.segments.push_back(static_cast<int32_t>(int(segment[1])));
    out.segment_edges.push_back(segment.edgenr);
  }
  return out;
}

void check_range(int32_t index, int count, const char *what) {
  if (index < 1 || index > count) throw std::out_of_range(std::string("mesh size on ") + what + " " + std::to_string(index) + " that does not exist");
}

}  // namespace

rust::String netgen_version() { return rust::String(NETGEN_VERSION); }

MeshData mesh_shape(const Shape &shape, const MeshParams &params, const Sizes &sizes) {
  Quiet quiet;
  netgen::OCCGeometry &geometry = *shape.geometry;
  if (sizes.face_ids.size() != sizes.face_sizes.size() || sizes.edge_ids.size() != sizes.edge_sizes.size())
    throw std::invalid_argument("mesh sizes: ids and sizes differ in length");
  // Per-shape maxh lives in Netgen's shape property registry; rebuilding the maps reads it and hands a face's maxh to its edges.
  for (size_t i = 0; i < sizes.face_ids.size(); ++i) {
    check_range(sizes.face_ids[i], geometry.fmap.Extent(), "face");
    auto &properties = netgen::OCCGeometry::GetProperties(geometry.fmap(sizes.face_ids[i]));
    properties.maxh = std::min(properties.maxh, sizes.face_sizes[i]);
  }
  for (size_t i = 0; i < sizes.edge_ids.size(); ++i) {
    check_range(sizes.edge_ids[i], geometry.emap.Extent(), "edge");
    auto &properties = netgen::OCCGeometry::GetProperties(geometry.emap(sizes.edge_ids[i]));
    properties.maxh = std::min(properties.maxh, sizes.edge_sizes[i]);
  }
  if (!sizes.face_ids.empty() || !sizes.edge_ids.empty()) geometry.BuildFMap();
  auto mp = meshing_parameters(params, sizes);
  auto mesh = std::make_shared<netgen::Mesh>();
  mesh->SetGeometry(shape.geometry);
  const int status = shape.geometry->GenerateMesh(mesh, mp);
  for (int k = 0; k < geometry.fmap.Extent(); ++k)
    if (geometry.facemeshstatus[k] != 1) throw std::runtime_error("Netgen could not mesh face " + std::to_string(k + 1));
  if (!params.surface_only && (status != 0 || mesh->GetNE() == 0)) throw std::runtime_error("Netgen could not fill the volume with tetrahedra");
  return extract(*mesh, !params.surface_only);
}

MeshData mesh_stl(rust::Slice<const double> facets, const MeshParams &params, const Sizes &sizes) {
  Quiet quiet;
  if (facets.size() == 0 || facets.size() % 9 != 0) throw std::invalid_argument("STL facets are 9 coordinates each");
  // ASCII STL through Netgen's exported reader (the in-memory triangle type is not exported); 17 digits keep every double exact.
  std::stringstream stl;
  stl << std::setprecision(17) << "solid llull\n";
  for (size_t i = 0; i < facets.size(); i += 9) {
    netgen::Point<3> corners[3];
    for (int k = 0; k < 3; ++k) corners[k] = netgen::Point<3>(facets[i + 3 * k], facets[i + 3 * k + 1], facets[i + 3 * k + 2]);
    netgen::Vec<3> normal = netgen::Cross(corners[1] - corners[0], corners[2] - corners[0]);
    if (normal.Length() > 0) normal /= normal.Length();
    stl << "facet normal " << normal(0) << ' ' << normal(1) << ' ' << normal(2) << "\nouter loop\n";
    for (const auto &corner : corners) stl << "vertex " << corner(0) << ' ' << corner(1) << ' ' << corner(2) << '\n';
    stl << "endloop\nendfacet\n";
  }
  stl << "endsolid llull\n";
  std::shared_ptr<netgen::STLGeometry> geometry(netgen::STLTopology::Load(stl));
  if (!geometry || (geometry->GetStatus() != netgen::STLTopology::STL_GOOD && geometry->GetStatus() != netgen::STLTopology::STL_WARNING))
    throw std::runtime_error("Netgen refused the STL surface (not a closed, consistently oriented triangulation)");
  netgen::stlparam.yangle = params.stl_edge_angle;
  auto mp = meshing_parameters(params, sizes);
  auto mesh = std::make_shared<netgen::Mesh>();
  mesh->SetGeometry(geometry);
  geometry->GenerateMesh(mesh, mp);
  if (!geometry->volumemeshed || mesh->GetNE() == 0) throw std::runtime_error("Netgen could not mesh the STL surface into tetrahedra");
  return extract(*mesh, true);
}

}  // namespace llull_netgen

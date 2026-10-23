// Prismatic B-rep from a segmented triangle mesh (07 MSH FR-MSH-21, TECHNICAL_SPEC 5.9): every group fitted by a plane, cylinder, cone or
// sphere becomes ONE face on that analytic surface, bounded by the exact intersection curves with its neighbours (GeomAPI_IntSS restricted to
// the mesh boundary chain); groups that are freeform, or whose boundary cannot be made exact, keep their triangles as planar faces. The faces
// are sewn into a solid, oriented and checked. Answers JSON text: { ok, error?, brep?, report }.
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <sstream>
#include <vector>

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <ElCLib.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_IntSS.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <Geom_Circle.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_Line.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Geom_Plane.hxx>
#include <Geom_SphericalSurface.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeFix_Face.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>

#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/queries.hxx"

namespace llull {
namespace {

enum Kind : uint8_t { kPlane = 0, kCylinder = 1, kCone = 2, kSphere = 3, kFaceted = 4 };

constexpr double kTwoPi = 6.283185307179586;

struct Group {
  Kind kind = kFaceted;
  Handle(Geom_Surface) surface;
  std::vector<uint32_t> faces;
};

struct Chain {
  std::vector<uint32_t> vertices;
  bool closed = false;
};

std::uint64_t edge_key(uint32_t a, uint32_t b) { return (static_cast<std::uint64_t>(std::min(a, b)) << 32) | std::max(a, b); }

// Handle(Geom_Surface) of one group from its 10 parameters (see the TypeScript `MeshToBrepGroup`).
Handle(Geom_Surface) make_surface(Kind kind, const double *p) {
  switch (kind) {
    case kPlane:
      return new Geom_Plane(gp_Pln(gp_Pnt(p[0], p[1], p[2]), gp_Dir(p[3], p[4], p[5])));
    case kCylinder:
      return new Geom_CylindricalSurface(gp_Ax3(gp_Pnt(p[0], p[1], p[2]), gp_Dir(p[3], p[4], p[5])), p[6]);
    case kCone:
      return new Geom_ConicalSurface(gp_Ax3(gp_Pnt(p[0], p[1], p[2]), gp_Dir(p[3], p[4], p[5])), p[6], 0.0);
    case kSphere:
      return new Geom_SphericalSurface(gp_Ax3(gp_Pnt(p[0], p[1], p[2]), gp_Dir(0, 0, 1)), p[3]);
    default:
      return Handle(Geom_Surface)();
  }
}

// Mesh edges between two groups, chained at the vertices where the boundary leaves the pair.
std::vector<Chain> chain_edges(const std::vector<std::pair<uint32_t, uint32_t>> &edges) {
  std::map<uint32_t, std::vector<size_t>> incident;
  for (size_t e = 0; e < edges.size(); ++e) {
    incident[edges[e].first].push_back(e);
    incident[edges[e].second].push_back(e);
  }
  std::vector<bool> used(edges.size(), false);
  std::vector<Chain> chains;
  auto walk = [&](uint32_t start, Chain &chain) {
    uint32_t at = start;
    chain.vertices.push_back(at);
    for (;;) {
      size_t next = edges.size();
      for (const size_t e : incident[at])
        if (!used[e]) {
          next = e;
          break;
        }
      if (next == edges.size()) return;
      used[next] = true;
      at = edges[next].first == at ? edges[next].second : edges[next].first;
      chain.vertices.push_back(at);
      if (at == start) {
        chain.closed = true;
        return;
      }
    }
  };
  for (const auto &entry : incident) {
    if (entry.second.size() == 2) continue;
    for (const size_t e : entry.second) {
      if (used[e]) continue;
      Chain chain;
      walk(entry.first, chain);
      chains.push_back(chain);
    }
  }
  for (size_t e = 0; e < edges.size(); ++e) {
    if (used[e]) continue;
    Chain chain;
    walk(edges[e].first, chain);
    chains.push_back(chain);
  }
  return chains;
}

double distance_to_curve(const Handle(Geom_Curve) & curve, const gp_Pnt &point, double &parameter) {
  if (const Handle(Geom_Line) line = Handle(Geom_Line)::DownCast(curve); !line.IsNull()) {
    const gp_Lin lin = line->Lin();
    parameter = ElCLib::Parameter(lin, point);
    return lin.Distance(point);
  }
  GeomAPI_ProjectPointOnCurve projection(point, curve);
  if (projection.NbPoints() < 1) return 1e300;
  parameter = projection.LowerDistanceParameter();
  return projection.LowerDistance();
}

// The exact edge(s) of one chain between two analytic surfaces; empty when no intersection curve follows the chain within `tolerance`.
std::vector<TopoDS_Edge> exact_chain_edges(const Handle(Geom_Surface) & first, const Handle(Geom_Surface) & second, const Chain &chain,
                                           const std::vector<gp_Pnt> &points, double tolerance) {
  GeomAPI_IntSS intersection(first, second, 1e-7);
  if (!intersection.IsDone() || intersection.NbLines() == 0) return {};
  Handle(Geom_Curve) best;
  double best_error = 1e300;
  for (int i = 1; i <= intersection.NbLines(); ++i) {
    Handle(Geom_Curve) curve = intersection.Line(i);
    if (const Handle(Geom_TrimmedCurve) trimmed = Handle(Geom_TrimmedCurve)::DownCast(curve); !trimmed.IsNull()) curve = trimmed->BasisCurve();
    const bool supported = !Handle(Geom_Line)::DownCast(curve).IsNull() || !Handle(Geom_Circle)::DownCast(curve).IsNull() ||
                           !Handle(Geom_Ellipse)::DownCast(curve).IsNull();
    if (!supported) continue;
    double worst = 0;
    double ignored = 0;
    for (const uint32_t v : chain.vertices) worst = std::max(worst, distance_to_curve(curve, points[v], ignored));
    if (worst < best_error) {
      best_error = worst;
      best = curve;
    }
  }
  if (best.IsNull() || best_error > tolerance) return {};
  const bool periodic = Handle(Geom_Line)::DownCast(best).IsNull();
  std::vector<double> parameters;
  for (const uint32_t v : chain.vertices) {
    double t = 0;
    distance_to_curve(best, points[v], t);
    if (!parameters.empty() && periodic) {
      while (t - parameters.back() > kTwoPi / 2) t -= kTwoPi;
      while (parameters.back() - t > kTwoPi / 2) t += kTwoPi;
    }
    parameters.push_back(t);
  }
  if (periodic && chain.closed) {
    BRepBuilderAPI_MakeEdge full(best);
    if (!full.IsDone()) return {};
    return {full.Edge()};
  }
  const double a = parameters.front();
  const double b = parameters.back();
  if (std::abs(b - a) < 1e-12) return {};
  BRepBuilderAPI_MakeEdge edge(best, std::min(a, b), std::max(a, b));
  if (!edge.IsDone()) return {};
  return {edge.Edge()};
}

std::vector<TopoDS_Edge> polyline_edges(const Chain &chain, const std::vector<gp_Pnt> &points) {
  std::vector<TopoDS_Edge> edges;
  for (size_t i = 0; i + 1 < chain.vertices.size(); ++i) {
    const gp_Pnt &p = points[chain.vertices[i]];
    const gp_Pnt &q = points[chain.vertices[i + 1]];
    if (p.SquareDistance(q) < 1e-24) continue;
    BRepBuilderAPI_MakeEdge edge(p, q);
    if (edge.IsDone()) edges.push_back(edge.Edge());
  }
  return edges;
}

TopoDS_Face triangle_face(const gp_Pnt &a, const gp_Pnt &b, const gp_Pnt &c) {
  if (gp_Vec(a, b).Crossed(gp_Vec(a, c)).SquareMagnitude() < 1e-24) return TopoDS_Face();
  BRepBuilderAPI_MakePolygon polygon(a, b, c, Standard_True);
  if (!polygon.IsDone()) return TopoDS_Face();
  BRepBuilderAPI_MakeFace face(polygon.Wire(), Standard_True);
  return face.IsDone() ? face.Face() : TopoDS_Face();
}

const char *kind_name(Kind kind) {
  static const char *names[] = {"plane", "cylinder", "cone", "sphere", "faceted"};
  return names[kind];
}

}  // namespace

// positions: xyz per vertex; indices: 3 per triangle; face_group: group id per triangle; kinds: one Kind per group; params: 10 per group.
rust::String mesh_to_brep_json(rust::Slice<const double> positions, rust::Slice<const uint32_t> indices, rust::Slice<const uint32_t> face_group,
                               rust::Slice<const uint8_t> kinds, rust::Slice<const double> params, double tolerance) {
  auto fail = [&](const std::string &message) {
    JsonWriter failed;
    failed.begin_object().key("ok").boolean(false).key("error").string(message).end_object();
    return rust::String(failed.text());
  };
  const size_t triangle_count = indices.size() / 3;
  if (positions.size() % 3 != 0 || indices.size() % 3 != 0 || face_group.size() != triangle_count || params.size() != kinds.size() * 10 || triangle_count == 0)
    return fail("meshToBrep: inconsistent arrays");
  std::vector<gp_Pnt> points;
  for (size_t i = 0; i + 2 < positions.size(); i += 3) points.emplace_back(positions[i], positions[i + 1], positions[i + 2]);
  std::vector<Group> groups(kinds.size());
  for (size_t g = 0; g < groups.size(); ++g) {
    if (kinds[g] > kFaceted) return fail("meshToBrep: unknown group kind " + std::to_string(kinds[g]));
    groups[g].kind = static_cast<Kind>(kinds[g]);
    if (groups[g].kind != kFaceted) groups[g].surface = make_surface(groups[g].kind, &params[g * 10]);
  }
  for (size_t t = 0; t < triangle_count; ++t) {
    if (face_group[t] >= groups.size()) return fail("meshToBrep: a face names a missing group");
    for (int k = 0; k < 3; ++k)
      if (indices[t * 3 + k] >= points.size()) return fail("meshToBrep: an index is out of range");
    groups[face_group[t]].faces.push_back(static_cast<uint32_t>(t));
  }
  // Boundary mesh edges per ordered pair of groups.
  std::map<std::uint64_t, std::vector<uint32_t>> edge_faces;
  for (size_t t = 0; t < triangle_count; ++t)
    for (int k = 0; k < 3; ++k) edge_faces[edge_key(indices[t * 3 + k], indices[t * 3 + (k + 1) % 3])].push_back(static_cast<uint32_t>(t));
  std::map<std::pair<uint32_t, uint32_t>, std::vector<std::pair<uint32_t, uint32_t>>> boundary;
  for (const auto &entry : edge_faces) {
    if (entry.second.size() != 2) return fail("meshToBrep: the mesh is not a closed manifold (an edge has " + std::to_string(entry.second.size()) + " faces)");
    const uint32_t ga = face_group[entry.second[0]];
    const uint32_t gb = face_group[entry.second[1]];
    if (ga == gb) continue;
    boundary[{std::min(ga, gb), std::max(ga, gb)}].emplace_back(static_cast<uint32_t>(entry.first >> 32), static_cast<uint32_t>(entry.first & 0xffffffffu));
  }
  // Edges per group: exact between two analytic groups when the intersection curve follows the chain, else straight segments.
  std::vector<std::vector<TopoDS_Edge>> group_edges(groups.size());
  std::vector<bool> demoted(groups.size(), false);
  int exact_chains = 0;
  int polyline_chains = 0;
  for (const auto &entry : boundary) {
    const uint32_t ga = entry.first.first;
    const uint32_t gb = entry.first.second;
    for (const Chain &chain : chain_edges(entry.second)) {
      std::vector<TopoDS_Edge> edges;
      if (!groups[ga].surface.IsNull() && !groups[gb].surface.IsNull()) edges = exact_chain_edges(groups[ga].surface, groups[gb].surface, chain, points, tolerance);
      if (edges.empty()) {
        edges = polyline_edges(chain, points);
        ++polyline_chains;
        // A curved boundary made of chords cannot bound an analytic face: both groups fall back to triangles.
        demoted[ga] = demoted[ga] || groups[ga].kind != kPlane || groups[gb].kind != kPlane;
        demoted[gb] = demoted[gb] || groups[ga].kind != kPlane || groups[gb].kind != kPlane;
      } else {
        ++exact_chains;
      }
      for (const TopoDS_Edge &edge : edges) {
        group_edges[ga].push_back(edge);
        group_edges[gb].push_back(edge);
      }
    }
  }
  BRepBuilderAPI_Sewing sewing(std::max(tolerance, 1e-6), Standard_True, Standard_True, Standard_True, Standard_False);
  int exact_faces = 0;
  int faceted_faces = 0;
  std::map<std::string, int> built;
  std::vector<std::string> faceted_groups;
  std::vector<std::string> notes;
  for (size_t g = 0; g < groups.size(); ++g) {
    bool made = false;
    if (groups[g].kind != kFaceted && demoted[g]) notes.push_back("group " + std::to_string(g) + ": boundary chain not followed by an exact curve");
    if (groups[g].kind != kFaceted && !demoted[g] && group_edges[g].empty()) notes.push_back("group " + std::to_string(g) + ": no edges");
    if (groups[g].kind != kFaceted && !demoted[g] && !group_edges[g].empty()) {
      Handle(TopTools_HSequenceOfShape) edges = new TopTools_HSequenceOfShape();
      for (const TopoDS_Edge &edge : group_edges[g]) edges->Append(edge);
      Handle(TopTools_HSequenceOfShape) wires;
      ShapeAnalysis_FreeBounds::ConnectEdgesToWires(edges, std::max(tolerance, 1e-6), Standard_False, wires);
      if (wires.IsNull() || wires->Length() == 0) notes.push_back("group " + std::to_string(g) + ": edges did not connect into wires");
      if (!wires.IsNull() && wires->Length() > 0) {
        TopoDS_Face result;
        for (const bool flip : {false, true}) {
          TopoDS_Face face;
          BRep_Builder builder;
          builder.MakeFace(face, groups[g].surface, Precision::Confusion());
          ShapeFix_Face fixer(face);
          fixer.SetPrecision(std::max(tolerance, 1e-6));
          for (int i = 1; i <= wires->Length(); ++i) {
            TopoDS_Wire wire = TopoDS::Wire(wires->Value(i));
            fixer.Add(flip ? TopoDS::Wire(wire.Reversed()) : wire);
          }
          fixer.Perform();
          fixer.FixOrientation();
          const TopoDS_Face candidate = fixer.Face();
          if (!candidate.IsNull() && BRepCheck_Analyzer(candidate).IsValid()) {
            result = candidate;
            break;
          }
        }
        if (result.IsNull())
          notes.push_back("group " + std::to_string(g) + ": face invalid after ShapeFix (" + std::to_string(wires->Length()) + " wire(s), " + std::to_string(group_edges[g].size()) + " edge(s))");
        if (!result.IsNull()) {
          sewing.Add(result);
          ++exact_faces;
          ++built[kind_name(groups[g].kind)];
          made = true;
        }
      }
    }
    if (made) continue;
    faceted_groups.push_back(std::to_string(g));
    for (const uint32_t t : groups[g].faces) {
      const TopoDS_Face face = triangle_face(points[indices[t * 3]], points[indices[t * 3 + 1]], points[indices[t * 3 + 2]]);
      if (!face.IsNull()) {
        sewing.Add(face);
        ++faceted_faces;
      }
    }
  }
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) return fail("meshToBrep: sewing produced nothing");
  BRepBuilderAPI_MakeSolid solid_maker;
  int shells = 0;
  for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
    solid_maker.Add(TopoDS::Shell(shell.Current()));
    ++shells;
  }
  if (shells == 0) return fail("meshToBrep: sewing left no shell (free edges " + std::to_string(sewing.NbFreeEdges()) + ")");
  solid_maker.Build();
  if (!solid_maker.IsDone()) return fail("meshToBrep: the shells do not make a solid");
  TopoDS_Solid solid = solid_maker.Solid();
  BRepLib::OrientClosedSolid(solid);
  GProp_GProps volume;
  BRepGProp::VolumeProperties(solid, volume);
  if (volume.Mass() < 0) {
    solid.Reverse();
    BRepGProp::VolumeProperties(solid, volume);
  }
  const BRepCheck_Analyzer check(solid);
  GProp_GProps area;
  BRepGProp::SurfaceProperties(solid, area);
  std::ostringstream stream;
  BRepTools::Write(solid, stream);
  JsonWriter json;
  json.begin_object().key("ok").boolean(true).key("brep").string(stream.str());
  json.key("report").begin_object();
  json.key("valid").boolean(check.IsValid());
  json.key("volume").number(volume.Mass());
  json.key("area").number(area.Mass());
  json.key("freeEdges").integer(sewing.NbFreeEdges());
  json.key("multipleEdges").integer(sewing.NbMultipleEdges());
  json.key("exactFaces").integer(exact_faces);
  json.key("facetedFaces").integer(faceted_faces);
  json.key("exactChains").integer(exact_chains);
  json.key("polylineChains").integer(polyline_chains);
  json.key("built").begin_object();
  for (const auto &entry : built) json.key(entry.first.c_str()).integer(entry.second);
  json.end_object();
  json.key("notes").begin_array();
  for (const std::string &note : notes) json.string(note);
  json.end_array();
  json.key("facetedGroups").begin_array();
  for (const std::string &g : faceted_groups) json.integer(std::stoll(g));
  json.end_array();
  json.end_object().end_object();
  return rust::String(json.text());
}

}  // namespace llull

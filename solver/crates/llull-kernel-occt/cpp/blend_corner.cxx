// Setback corners (BLD M3, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.5, §13.10, §13.12). Scope of this build: every edge that meets a setback vertex is a
// STRAIGHT edge between two PLANAR faces, all convex (the blends remove material) or all concave (they add it) at one vertex, rounded in the same step with a circular
// radius that is constant or linear between the two ends of the edge; each rounded edge ends at a setback vertex (the other end of an edge may be free: it ends on one
// flat face). The edge blends are the spandrel prisms of blend_profile.cxx (a ruled loft of two sections when the radius tapers), each stopping at the section plane
// `setback` away from its vertex; the sharp stubs and the flat end walls that leave at the vertex are then replaced by a patch (BRepOffsetAPI_MakeFilling, G1 to the
// blend ends and to the support faces along straight chords between the contact points), sewn into a solid.
// A reason that starts with "[CODE] " carries the stable BLD_* code it maps to.
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakeFilling.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <GProp_GProps.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <TopTools_MapOfShape.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include "llull-kernel-occt/cpp/blend_solid.hxx"
#include "llull-kernel-occt/cpp/blend_tool.hxx"
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/naming.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"

namespace llull {

using namespace blend;

namespace {

// Two points closer than this fraction of the solid's bounding-box diagonal are the same vertex (the same rule as geometry/blend/vertices.ts).
constexpr double kVertexFraction = 1e-7;
// The patch may leave its support surfaces by at most this angle (radians): the OCCT MakeFilling TolAng default of the SRF pack.
constexpr double kFillAngle = 0.01;
// The patch is a B-spline approximation of the plate surface: it leaves the edges it is sewn to by up to about 2e-6 x the diagonal at the fill settings
// below (MakeFilling's own G0Error does not see it), so a patch is accepted up to 5e-6 x the diagonal.
constexpr double kPatchGapFraction = 5e-6;
// The 3D tolerance of the fill is at most this fraction of the smallest setback of its corner.
constexpr double kFillSetbackFraction = 1e-4;
// MakeFilling settings: plate degree, constraint points per curve, iterations, and the B-spline approximation of the plate (maximum degree and
// segments; the OCCT defaults 8 / 9 leave the patch up to 6e-4 off the edges it is sewn to and 0.019 rad off tangent at the corners).
constexpr int kFillDegree = 3, kFillIterations = 2;
// 30 segments would halve the fill time but leave the patch 3.2 to 3.4e-6 x the diagonal off its edges and the end-point angle of a
// profile corner at 0.012 rad on a 1000 mm cube (above the check_blends G1 default), so 60 is the first setting.
// The fits tried in turn (points per curve, approximation degree, segments): the first leaves 1.4 to 1.7e-6 x the diagonal at the samples of 21 points, but
// the gap measured at 101 points reaches 6e-6 near the hole corners on some parts, and the gap of a fit is not monotonic in its settings, so a patch over the
// limit is filled again with the next.
struct FillSetting {
  int points, max_degree, segments;
};
constexpr FillSetting kFillSettings[] = {{15, 12, 60}, {15, 14, 100}, {40, 12, 100}, {15, 13, 100}, {25, 12, 60}};
// A setback must exceed the distance its blends reach by this relative margin (equal means the contact lines meet in one point).
constexpr double kMarginRelative = 1e-9;

// check_blends samples a contact at up to 101 points (its `samples` limit): the built gap is measured at as many.
constexpr int kGapSamples = 100;

constexpr const char *kUnsupported = "[BLD_CORNER_UNSUPPORTED] ";
constexpr const char *kTooShort = "[BLD_SETBACK_TOO_SHORT] ";
constexpr const char *kFailed = "[BLD_CORNER_FAILED] ";

// How the edge blends and corners are made: the section of every edge (kind as for spandrel_tool: 0 conic, 1 curvature, 2 circular) and whether the
// corners are given (setback distances) or found: every vertex where rounded edges meet, with the least setback that leaves the patch a face.
struct Mode {
  int kind = 2;
  double param = 0.0;
  bool automatic = false;
  double factor = 2.0;  // automatic corners: setback relative to the least one the neighbouring blends allow
};
// The factors an automatic corner tries in turn (the fill of a patch is more or less exact depending on the section and the size of the patch).
constexpr double kAutomaticFactors[] = {2.0, 1.5, 2.5, 1.25, 3.0};

// The radius of a rounded edge at its start and at its end (the edge direction of the kernel); it varies linearly along the edge.
struct Taper {
  double start = 0.0, end = 0.0;
  bool constant() const { return std::fabs(end - start) <= 1e-9 * std::max(start, end); }
};

struct Corner {
  gp_Pnt at;
  std::vector<std::pair<int, double>> setbacks;  // unique edge index of the source, distance
};

struct Wall {
  gp_Pnt point;   // where the sharp stub of an edge ends (the section plane meets the edge)
  gp_Vec stub;    // unit direction of the stub, away from the vertex
};

std::string number(double value) {
  std::ostringstream text;
  text.precision(6);
  text << value;
  return text.str();
}

std::string where(const gp_Pnt &point) { return "[" + number(point.X()) + ", " + number(point.Y()) + ", " + number(point.Z()) + "]"; }

bool same_point(const gp_Pnt &a, const gp_Pnt &b, double tolerance) { return a.Distance(b) <= tolerance; }

bool listed(const TopTools_ListOfShape &list, const TopoDS_Shape &shape) {
  for (TopTools_ListIteratorOfListOfShape it(list); it.More(); it.Next())
    if (it.Value().IsSame(shape)) return true;
  return false;
}

std::string joined_names(std::vector<std::string> parts) {
  std::sort(parts.begin(), parts.end());
  parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
  std::string text;
  for (size_t i = 0; i < parts.size(); ++i) text += (i == 0 ? "" : ",") + parts[i];
  return text;
}

// The vertex of `shape` nearest to `at` within the vertex tolerance (null when none).
TopoDS_Vertex vertex_at(const TopoDS_Shape &shape, const gp_Pnt &at, double tolerance) {
  TopTools_IndexedMapOfShape vertices;
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  TopoDS_Vertex best;
  double nearest = 1e300;
  for (int v = 1; v <= vertices.Extent(); ++v) {
    const double gap = BRep_Tool::Pnt(TopoDS::Vertex(vertices(v))).Distance(at);
    if (gap < nearest && same_point(BRep_Tool::Pnt(TopoDS::Vertex(vertices(v))), at, tolerance)) {
      nearest = gap;
      best = TopoDS::Vertex(vertices(v));
    }
  }
  return best;
}

// The unique indices of the non-degenerate edges meeting at `vertex`.
std::vector<int> edges_at(const TopTools_IndexedDataMapOfShapeListOfShape &vertex_edges, const TopTools_IndexedMapOfShape &edge_map,
                          const TopoDS_Vertex &vertex) {
  std::vector<int> found;
  for (TopTools_ListIteratorOfListOfShape it(vertex_edges.FindFromKey(vertex)); it.More(); it.Next()) {
    if (BRep_Tool::Degenerated(TopoDS::Edge(it.Value()))) continue;
    const int index = edge_map.FindIndex(it.Value()) - 1;
    if (index >= 0 && std::find(found.begin(), found.end(), index) == found.end()) found.push_back(index);
  }
  return found;
}

bool parse(rust::Slice<const double> edges, rust::Slice<const double> corners, bool automatic, std::map<int, Taper> &radius,
           std::vector<Corner> &list, std::string &why) {
  if (edges.empty() || edges.size() % 3 != 0) {
    why = std::string(kFailed) + "the setback blend parameters are malformed (edges)";
    return false;
  }
  for (size_t at = 0; at < edges.size(); at += 3) {
    if (!(edges[at + 1] > 0) || !(edges[at + 2] > 0) || edges[at] < 0) {
      why = std::string(kFailed) + "the radius of every rounded edge must be > 0";
      return false;
    }
    radius[static_cast<int>(edges[at])] = Taper{edges[at + 1], edges[at + 2]};
  }
  size_t at = 0;
  while (at < corners.size()) {
    if (at + 4 > corners.size()) {
      why = std::string(kFailed) + "the setback blend parameters are malformed (corners)";
      return false;
    }
    Corner corner;
    corner.at = gp_Pnt(corners[at], corners[at + 1], corners[at + 2]);
    const size_t count = static_cast<size_t>(corners[at + 3]);
    at += 4;
    if (count < 3 || at + 2 * count > corners.size()) {
      why = std::string(kFailed) + "the setback blend parameters are malformed (corner edges)";
      return false;
    }
    for (size_t k = 0; k < count; ++k) corner.setbacks.emplace_back(static_cast<int>(corners[at + 2 * k]), corners[at + 2 * k + 1]);
    at += 2 * count;
    list.push_back(std::move(corner));
  }
  if (list.empty() && !automatic) {
    why = std::string(kFailed) + "the setback blend needs at least one corner";
    return false;
  }
  return true;
}

// What the build learns about the source before any geometry is made.
struct Plan {
  double tolerance = 1e-9;                          // two points closer than this are the same vertex
  std::map<int, EdgeFrame> frames;
  std::map<int, Taper> radii;                       // radius of each rounded edge at its two ends
  std::map<int, double> half_tangent;               // tan(fold / 2) of each rounded edge: its tangent distance is the radius times this
  // Tangent distance of edge `edge` at `along` (distance from the start of the edge).
  double leg_at(int edge, double along) const {
    const Taper &taper = radii.at(edge);
    return (taper.start + (taper.end - taper.start) * along / frames.at(edge).length) * half_tangent.at(edge);
  }
  std::vector<TopoDS_Vertex> vertices;              // source vertex of each corner
  std::vector<std::map<int, gp_Vec>> stubs;         // per corner: unit direction away from the vertex of each incident edge
  std::vector<bool> concave;                        // per corner: its edges are concave (the blends add material), else convex (they remove it)
};

// Checks the corner `c` against the source and fills `plan`; false with the reason in `why`.
bool plan_corner(const TopoDS_Shape &shape, const TopTools_IndexedMapOfShape &edge_map, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_edges,
                 const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces, const std::map<int, Taper> &radius, const Mode &mode,
                 Corner &corner, Plan &plan, std::string &why) {
  const TopoDS_Vertex vertex = vertex_at(shape, corner.at, plan.tolerance);
  if (vertex.IsNull()) {
    why = std::string(kFailed) + "the solid has no vertex at " + where(corner.at);
    return false;
  }
  plan.vertices.push_back(vertex);
  const std::vector<int> incident = edges_at(vertex_edges, edge_map, vertex);
  const std::string noun = mode.automatic ? "profile corner" : "setback corner";
  if (incident.size() < 3) {
    why = std::string(kUnsupported) + "only " + std::to_string(incident.size()) + " edge(s) meet at " + where(corner.at) + ": a " + noun +
          " needs 3 or more";
    return false;
  }
  std::map<int, gp_Vec> stub;
  std::map<int, double> distance;
  for (const int edge : incident) {
    if (radius.find(edge) == radius.end()) {
      why = std::string(kUnsupported) + "edge " + std::to_string(edge) + " meets the " + (mode.automatic ? "vertex " : "setback vertex ") +
            where(corner.at) + " but is not rounded: a " + noun + " rounds every edge that meets there, in the same step";
      return false;
    }
    const auto found = std::find_if(corner.setbacks.begin(), corner.setbacks.end(), [&](const auto &entry) { return entry.first == edge; });
    if (!mode.automatic && (found == corner.setbacks.end() || !(found->second > 0))) {
      why = std::string(kFailed) + "no setback distance for edge " + std::to_string(edge) + " at " + where(corner.at);
      return false;
    }
    distance[edge] = mode.automatic ? 1.0 : found->second;
    const EdgeFrame &frame = plan.frames.at(edge);
    if (same_point(frame.start, corner.at, plan.tolerance)) stub[edge] = frame.direction;
    else if (same_point(frame.end, corner.at, plan.tolerance)) stub[edge] = frame.direction.Reversed();
    else {
      why = std::string(kFailed) + "edge " + std::to_string(edge) + " does not end at " + where(corner.at);
      return false;
    }
  }
  const int concave_edges = static_cast<int>(std::count_if(incident.begin(), incident.end(), [&](int edge) { return !plan.frames.at(edge).convex; }));
  if (concave_edges != 0 && concave_edges != static_cast<int>(incident.size())) {
    why = std::string(kUnsupported) + "convex and concave edges meet at " + where(corner.at) + " (" + std::to_string(concave_edges) + " of " +
          std::to_string(incident.size()) + " are concave): a " + noun + " rounds the edges of one kind, a vertex of mixed kinds has no patch in this build";
    return false;
  }
  plan.concave.push_back(concave_edges != 0);
  // Each face at the vertex is bounded there by exactly two rounded edges i, j whose contact lines (distance leg_i, leg_j from the edges, inside the
  // face) meet in one point; the setback of an edge must end beyond it, else the chord of the patch across the face has no length.
  // The tangent distance of edge e at setback d from this vertex is a_e + g_e d (the radius may vary linearly along an edge; g_e = 0 for a constant one).
  // The setback must exceed every distance the blends reach, and those distances are linear in d_e, so the least setback is a closed form per term:
  // d > c0 + c1 d  <=>  d > c0 / (1 - c1); a slope c1 >= 1 means no setback outruns the growing blend.
  std::map<int, double> offset, slope;
  for (const int edge : incident) {
    const EdgeFrame &frame = plan.frames.at(edge);
    const bool from_start = same_point(frame.start, corner.at, plan.tolerance);
    const double rate = (plan.radii.at(edge).end - plan.radii.at(edge).start) / frame.length * plan.half_tangent.at(edge);
    offset[edge] = plan.leg_at(edge, from_start ? 0.0 : frame.length);
    slope[edge] = from_start ? rate : -rate;
  }
  const auto leg_of = [&](int edge) { return offset.at(edge) + slope.at(edge) * distance.at(edge); };
  struct Term {
    double c0, c1;
    bool cross;  // from the blend of a neighbour on a shared face, not from the edge's own
  };
  std::map<int, std::vector<Term>> terms;  // per edge
  struct Pair {
    int i, j;
    double cosine, sine;
  };
  std::vector<Pair> pairs;  // the two rounded edges that bound each face at the vertex, and the angle between them
  for (const int edge : incident) terms[edge].push_back({offset.at(edge), slope.at(edge), false});
  for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) {
    std::vector<int> on_face;
    for (const int edge : incident) {
      const EdgeFrame &frame = plan.frames.at(edge);
      if (frame.faces[0].IsSame(it.Value()) || frame.faces[1].IsSame(it.Value())) on_face.push_back(edge);
    }
    if (on_face.size() != 2) {
      why = std::string(kUnsupported) + "a face meets the vertex " + where(corner.at) + " with " + std::to_string(on_face.size()) +
            " rounded edges (2 expected)";
      return false;
    }
    const int i = on_face[0], j = on_face[1];
    const double cosine = stub[i].Dot(stub[j]);
    const double sine = stub[i].Crossed(stub[j]).Magnitude();
    if (sine < 1e-6) {
      why = std::string(kUnsupported) + "two edges leave " + where(corner.at) + " along one line";
      return false;
    }
    pairs.push_back({i, j, cosine, sine});
    terms[i].push_back({(leg_of(j) + offset.at(i) * cosine) / sine, slope.at(i) * cosine / sine, true});
    terms[j].push_back({(leg_of(i) + offset.at(j) * cosine) / sine, slope.at(j) * cosine / sine, true});
  }
  std::map<int, double> required;
  for (const int edge : incident) {
    required[edge] = 0.0;
    for (const Term &term : terms.at(edge)) {
      if (term.c1 >= 1.0) {
        why = std::string(kUnsupported) + (term.cross ? "the reach of its neighbour's blend along edge " : "the radius of edge ") + std::to_string(edge) +
              " grows by " + number(term.c1) + " per unit of setback at " + where(corner.at) + ": no setback outruns it (the radius law is too steep there)";
        return false;
      }
      required[edge] = std::max(required[edge], term.c0 / (1.0 - term.c1));
    }
  }
  if (mode.automatic) {
    corner.setbacks.clear();
    for (const int edge : incident) {
      distance[edge] = required[edge] * mode.factor;
      corner.setbacks.emplace_back(edge, distance[edge]);
    }
  }
  for (const int edge : incident)
    if (distance[edge] <= required[edge] * (1 + kMarginRelative)) {
      // The number to report is the least setback that works when the neighbours' setbacks move with it, not the one that holds them at the given values
      // (the blend of a neighbour reaches further when its own setback grows with a tapered radius, or at an angle other than a right one): the joint
      // minimum, uniform when every edge was given the same setback, else the least fixed point of the setbacks of all the edges.
      const bool uniform = std::all_of(incident.begin(), incident.end(), [&](int e) { return std::fabs(distance[e] - distance[edge]) <= 1e-12 * distance[edge]; });
      std::map<int, double> least;
      std::string problem;
      if (uniform) {
        double best = 0.0;
        for (const int e : incident) best = std::max(best, offset.at(e) / (1.0 - slope.at(e)));
        for (const Pair &pair : pairs)
          for (const auto &[a, b] : {std::make_pair(pair.i, pair.j), std::make_pair(pair.j, pair.i)}) {
            const double denominator = pair.sine - slope.at(b) - slope.at(a) * pair.cosine;
            if (denominator <= 1e-12) problem = "edges " + std::to_string(a) + " and " + std::to_string(b) + " (their blends outgrow the setback)";
            else best = std::max(best, (offset.at(b) + offset.at(a) * pair.cosine) / denominator);
          }
        for (const int e : incident) least[e] = best;
      } else {
        for (const int e : incident) least[e] = 0.0;
        bool settled = false;
        for (int round = 0; round < 1000 && !settled; ++round) {
          std::map<int, double> next;
          for (const int e : incident) next[e] = offset.at(e) + slope.at(e) * least.at(e);
          for (const Pair &pair : pairs)
            for (const auto &[a, b] : {std::make_pair(pair.i, pair.j), std::make_pair(pair.j, pair.i)})
              next[a] = std::max(next[a], (offset.at(b) + slope.at(b) * least.at(b) + (offset.at(a) + slope.at(a) * least.at(a)) * pair.cosine) / pair.sine);
          settled = true;
          for (const int e : incident) {
            settled = settled && std::fabs(next[e] - least[e]) <= 1e-10 * std::max(std::fabs(next[e]), 1e-300);
            least[e] = next[e];
          }
        }
        if (!settled) problem = "the setbacks of the edges (they do not settle: the blends outgrow them)";
      }
      if (!problem.empty()) {
        why = std::string(kUnsupported) + "no setback outruns the blends at " + where(corner.at) + ": " + problem;
        return false;
      }
      std::string list;
      for (const int e : incident) list += (list.empty() ? "" : ", ") + std::string("edge ") + std::to_string(e) + " " + number(least.at(e));
      why = std::string(kTooShort) + "setback " + number(distance[edge]) + " on edge " + std::to_string(edge) + " at " + where(corner.at) +
            " must exceed " + number(least.at(edge)) + " (the least " + (uniform ? "setback of every edge there" : "setbacks together") + ": " + list +
            "; the distance along the edge its neighbours' blends reach)";
      return false;
    }
  plan.stubs.push_back(stub);
  return true;
}


// How far past the free vertex of a rounded edge the prism must run to leave the solid through the one face that closes it there (0 when that
// face is square to the edge); false with the reason in `why` when the end is not a plain 3-face vertex.
bool free_extension(const TopoDS_Shape &shape, double tolerance, const TopTools_IndexedDataMapOfShapeListOfShape &vertex_faces,
                    const EdgeFrame &frame, bool at_end, double leg, double &extension, std::string &why) {
  const gp_Pnt point = at_end ? frame.end : frame.start;
  const TopoDS_Vertex vertex = vertex_at(shape, point, tolerance);
  if (vertex.IsNull()) {
    why = std::string(kFailed) + "the free end " + where(point) + " of a rounded edge is not a vertex";
    return false;
  }
  TopTools_IndexedMapOfShape around;
  for (TopTools_ListIteratorOfListOfShape it(vertex_faces.FindFromKey(vertex)); it.More(); it.Next()) around.Add(it.Value());
  // The faces other than the two of the edge must be flat and coplanar (one face, or a face the sewing left in several pieces).
  TopoDS_Face closing;
  bool plain = true;
  for (int f = 1; f <= around.Extent(); ++f) {
    if (around(f).IsSame(frame.faces[0]) || around(f).IsSame(frame.faces[1])) continue;
    const TopoDS_Face face = TopoDS::Face(around(f));
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) plain = false;
    else if (closing.IsNull()) closing = face;
    else plain = plain && outward_normal(shape, face).Dot(outward_normal(shape, closing)) > 1 - 1e-9;
  }
  if (!plain || closing.IsNull()) {
    why = std::string(kUnsupported) + "a rounded edge ends at " + where(point) + ", which has no setback corner and is not a vertex closed by one flat face";
    return false;
  }
  const gp_Vec outward = at_end ? frame.direction : frame.direction.Reversed();
  const gp_Vec normal = outward_normal(shape, closing);
  const double slope = normal.Dot(outward);
  if (slope < 0.1) {
    why = std::string(kUnsupported) + "the face closing the rounded edge at " + where(point) + " is too oblique to the edge";
    return false;
  }
  extension = 0;
  if (slope > 1 - 1e-9) return true;
  if (!frame.convex) {
    // A concave blend adds material: running it past the closing face would add it outside the part, so it must end flush.
    why = std::string(kUnsupported) + "a concave rounded edge ends at " + where(point) + " on a face that is not square to it";
    return false;
  }
  const gp_Pnt corners[3] = {point, point.Translated(frame.inward[0] * leg), point.Translated(frame.inward[1] * leg)};
  for (const gp_Pnt &corner : corners) extension = std::max(extension, -normal.Dot(gp_Vec(point, corner)) / slope);
  extension += 0.25 * leg;
  return true;
}

// The flat wall that the prism of the edge with sharp stub `wall` leaves in `shape` (planar, square to the stub, through its end); null if none.
TopoDS_Face wall_in(const TopoDS_Shape &shape, const Wall &wall, double tolerance) {
  TopTools_IndexedMapOfShape faces = query::distinct(shape, TopAbs_FACE);
  for (int f = 1; f <= faces.Extent(); ++f) {
    const TopoDS_Face face = TopoDS::Face(faces(f));
    if (BRepAdaptor_Surface(face, Standard_True).GetType() != GeomAbs_Plane) continue;
    const gp_Vec normal = normal_of(face);
    const gp_Pnt origin = BRepAdaptor_Surface(face, Standard_True).Plane().Location();
    // `inside` projects the point onto the plane, so the plane itself must be the one through the point.
    if (std::fabs(normal.Dot(wall.stub)) > 1 - 1e-9 && std::fabs(normal.Dot(gp_Vec(origin, wall.point))) < tolerance && inside(face, wall.point))
      return face;
  }
  return TopoDS_Face();
}

TopoDS_Edge arc_of(const TopoDS_Face &wall) {
  for (TopExp_Explorer it(wall, TopAbs_EDGE); it.More(); it.Next())
    if (BRepAdaptor_Curve(TopoDS::Edge(it.Current())).GetType() != GeomAbs_Line) return TopoDS::Edge(it.Current());
  return TopoDS_Edge();
}

// The edges of `pending` chained into one closed loop, or empty when they do not form one.
std::vector<TopoDS_Edge> loop_of(std::vector<TopoDS_Edge> pending) {
  std::vector<TopoDS_Edge> loop;
  if (pending.empty()) return loop;
  loop.push_back(pending.back());
  pending.pop_back();
  TopoDS_Vertex tail = TopExp::LastVertex(loop.back(), Standard_True);
  while (!pending.empty()) {
    bool extended = false;
    for (size_t k = 0; k < pending.size() && !extended; ++k) {
      const TopoDS_Vertex first = TopExp::FirstVertex(pending[k], Standard_True), last = TopExp::LastVertex(pending[k], Standard_True);
      if (first.IsSame(tail) || last.IsSame(tail)) {
        tail = first.IsSame(tail) ? last : first;
        loop.push_back(pending[k]);
        pending.erase(pending.begin() + static_cast<long>(k));
        extended = true;
      }
    }
    if (!extended) return {};
  }
  return loop;
}

// Largest distance between the 3D curve of `edge` and the surface of `face` at the pcurve of the edge, over kGapSamples + 1 samples; false when the edge has no
// pcurve on the face or its curves do not share a parameter (the distance would mean nothing).
bool edge_gap(const TopoDS_Edge &edge, const TopoDS_Face &face, double &worst) {
  double first = 0, last = 0;
  const Handle(Geom2d_Curve) pcurve = BRep_Tool::CurveOnSurface(edge, face, first, last);
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  if (pcurve.IsNull() || surface.IsNull() || !BRep_Tool::SameParameter(edge)) return false;
  const BRepAdaptor_Curve curve(edge);
  worst = 0;
  for (int k = 0; k <= kGapSamples; ++k) {
    const double t = first + (last - first) * k / static_cast<double>(kGapSamples);
    const gp_Pnt2d uv = pcurve->Value(t);
    worst = std::max(worst, surface->Value(uv.X(), uv.Y()).Distance(curve.Value(t)));
  }
  return true;
}

// The diagonal of the box of `members` (the faces of the solid about to be sewn) where each of the last `patch_count` faces counts by its edges only. The
// true box of the solid is never smaller, so a limit built from this diagonal is never looser than the one check_blends computes; the box of a patch
// (a B-spline of thousands of poles) costs more than the whole rest of a corner.
double lower_diagonal(const std::vector<TopoDS_Face> &members, size_t patch_count) {
  Bnd_Box box;
  const size_t plain = members.size() - std::min(members.size(), patch_count);
  for (size_t m = 0; m < members.size(); ++m) {
    if (m < plain) BRepBndLib::AddOptimal(members[m], box, Standard_False, Standard_False);
    else
      for (TopExp_Explorer it(members[m], TopAbs_EDGE); it.More(); it.Next()) BRepBndLib::AddOptimal(it.Current(), box, Standard_False, Standard_False);
  }
  if (box.IsVoid()) return 0.0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return gp_Pnt(x0, y0, z0).Distance(gp_Pnt(x1, y1, z1));
}

double volume_of(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

std::unique_ptr<Shape> build_setback(const Shape &source, rust::Slice<const double> edge_raw, rust::Slice<const double> corner_raw, const Mode &mode,
                                     bool &fill_failed, std::string &corners_json, std::string &why) {
  fill_failed = false;
  std::map<int, Taper> radius;
  std::vector<Corner> corners;
  if (!parse(edge_raw, corner_raw, mode.automatic, radius, corners, why)) return nullptr;
  const TopoDS_Shape &shape = source.shape;
  const double diagonal = blend::diagonal_of(shape);
  // Deliberately the box of the VERTICES: core matches vertices with the same scale (geometry/blend/vertices.ts); it decides no acceptance.
  const double vertex_tolerance = kVertexFraction * std::max(blend::vertex_diagonal_of(shape), 1e-9);
  // The sewing tolerance (an input of the sewing and of the fill): the check_blends default g0 of the true box.
  const double sewing_tolerance = std::max(1e-6 * diagonal, 1e-12);
  // How far a corner patch may leave the edges it is sewn to while it is made (check_blends judges corner contacts against the same fraction of the
  // true diagonal); the acceptance is repeated against the smaller of the source's and the result's diagonal once the solid exists.
  const double patch_gap_limit = blend::kGapAccepted * kPatchGapFraction * diagonal;
  double worst_patch_gap = 0;
  const TopTools_IndexedMapOfShape edge_map = query::distinct(shape, TopAbs_EDGE);
  TopTools_IndexedDataMapOfShapeListOfShape vertex_edges, vertex_faces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);

  Plan plan;
  plan.tolerance = vertex_tolerance;
  for (const auto &[index, taper] : radius) {
    EdgeFrame frame;
    if (!edge_frame(shape, index, mode.automatic ? "profile corners" : "setback blends", frame, why)) {
      why = std::string(kUnsupported) + why;
      return nullptr;
    }
    if (mode.automatic && !frame.convex) {
      why = std::string(kUnsupported) + "edge " + std::to_string(index) + " is concave: profile corners round convex edges";
      return nullptr;
    }
    plan.frames[index] = frame;
    plan.radii[index] = taper;
    plan.half_tangent[index] = std::tan(frame.fold / 2);
    if (mode.automatic && !taper.constant()) {
      why = std::string(kUnsupported) + "profile corners need one constant size per edge (edge " + std::to_string(index) + " varies)";
      return nullptr;
    }
    if (!taper.constant() && mode.kind != 2) {
      why = std::string(kUnsupported) + "a radius that varies along edge " + std::to_string(index) + " is made for circular blends only";
      return nullptr;
    }
  }
  if (mode.automatic) {
    // A corner at every vertex where two or more of the rounded edges meet (plan_corner checks the rest).
    std::vector<TopoDS_Vertex> found;
    for (const auto &[index, taper] : radius)
      for (const gp_Pnt &point : {plan.frames.at(index).start, plan.frames.at(index).end}) {
        const TopoDS_Vertex vertex = vertex_at(shape, point, vertex_tolerance);
        if (vertex.IsNull() || std::any_of(found.begin(), found.end(), [&](const TopoDS_Vertex &known) { return known.IsSame(vertex); })) continue;
        int rounded = 0;
        for (const int other : edges_at(vertex_edges, edge_map, vertex)) rounded += radius.count(other) ? 1 : 0;
        if (rounded < 2) continue;
        found.push_back(vertex);
        Corner corner;
        corner.at = BRep_Tool::Pnt(vertex);
        corners.push_back(std::move(corner));
      }
  }
  for (Corner &corner : corners)
    if (!plan_corner(shape, edge_map, vertex_edges, vertex_faces, radius, mode, corner, plan, why)) return nullptr;

  {
    JsonWriter log;
    log.begin_array();
    for (const Corner &corner : corners) {
      log.begin_object().key("vertex").point(corner.at).key("setbacks").begin_array();
      for (const auto &[edge, distance] : corner.setbacks) log.begin_object().key("edge").integer(edge).key("distance").number(distance).end_object();
      log.end_array().end_object();
    }
    corners_json = log.end_array().text();
  }

  // Edge blends: one prism per rounded edge, from the section plane at its setback end(s) to the vertex plane (or past a free end).
  const naming::Named input = naming::named(source);
  const std::vector<std::string> edge_names = naming::edge_names(shape, input.names);
  const auto corner_at = [&](const gp_Pnt &point) {
    for (size_t c = 0; c < corners.size(); ++c)
      if (same_point(corners[c].at, point, vertex_tolerance)) return static_cast<int>(c);
    return -1;
  };
  // The setback of `edge` at `corner`; plan_corner guarantees an entry for every edge meeting a corner, a missing one is -1.
  const auto setback_of = [&](int corner, int edge) {
    const auto &list = corners[static_cast<size_t>(corner)].setbacks;
    const auto found = std::find_if(list.begin(), list.end(), [&](const auto &entry) { return entry.first == edge; });
    return found == list.end() ? -1.0 : found->second;
  };
  std::vector<Tool> tools;
  for (const auto &[index, taper] : radius) {
    const EdgeFrame &frame = plan.frames.at(index);
    const int start_corner = corner_at(frame.start), end_corner = corner_at(frame.end);
    const std::string label = "edge " + std::to_string(index);
    if (start_corner < 0 && end_corner < 0) {
      why = std::string(kUnsupported) + label + " does not end at a setback vertex: every rounded edge must meet one in this build";
      return nullptr;
    }
    double lo = 0, hi = frame.length;
    for (const bool at_end : {false, true}) {
      const int corner = at_end ? end_corner : start_corner;
      if (corner >= 0) {
        const double distance = setback_of(corner, index);
        if (!(distance > 0)) {
          why = std::string(kFailed) + "no setback distance for " + label + " at " + where(corners[static_cast<size_t>(corner)].at);
          return nullptr;
        }
        (at_end ? hi : lo) += (at_end ? -1 : 1) * distance;
        continue;
      }
      const gp_Pnt free_point = at_end ? frame.end : frame.start;
      const TopoDS_Vertex vertex = vertex_at(shape, free_point, vertex_tolerance);
      for (const int other : edges_at(vertex_edges, edge_map, vertex))
        if (other != index && radius.find(other) != radius.end()) {
          why = std::string(kUnsupported) + "edges " + std::to_string(index) + " and " + std::to_string(other) + " meet at " + where(free_point) +
                ", which has no setback corner";
          return nullptr;
        }
      double extension = 0;
      if (!free_extension(shape, vertex_tolerance, vertex_faces, frame, at_end, plan.leg_at(index, at_end ? frame.length : 0.0), extension, why)) return nullptr;
      (at_end ? hi : lo) += (at_end ? 1 : -1) * extension;
    }
    if (!(hi - lo > 1e-6 * frame.length)) {
      why = std::string(kFailed) + "the setbacks at both ends of " + label + " leave no length to round (edge length " + number(frame.length) + ")";
      return nullptr;
    }
    const double leg_lo = plan.leg_at(index, lo), leg_hi = plan.leg_at(index, hi);
    if (!(leg_lo > 0) || !(leg_hi > 0)) {
      why = std::string(kUnsupported) + "the radius of " + label + " is not positive over the length that is rounded";
      return nullptr;
    }
    const auto leg_ok = [&](double along, double leg) {
      const gp_Pnt base = frame.start.Translated(frame.direction * along);
      return inside(frame.faces[0], base.Translated(frame.inward[0] * leg)) && inside(frame.faces[1], base.Translated(frame.inward[1] * leg));
    };
    if ((start_corner >= 0 && !leg_ok(lo, leg_lo)) || (end_corner >= 0 && !leg_ok(hi, leg_hi))) {
      why = std::string(kUnsupported) + "the round of " + label + " (tangent distance " + number(std::max(leg_lo, leg_hi)) +
            ") reaches past its faces at the setback section";
      return nullptr;
    }
    const gp_Pnt from = frame.start.Translated(frame.direction * lo), to = frame.start.Translated(frame.direction * hi);
    const std::string blend_name = "blend(" + edge_names[static_cast<size_t>(index)] + ")";
    Tool tool;
    if (taper.constant()) {
      if (!spandrel_tool(from, to, from.Translated(frame.inward[0] * leg_lo), from.Translated(frame.inward[1] * leg_lo), mode.kind, mode.param,
                         kPi - frame.fold, blend_name, tool, why))
        return nullptr;
    } else if (!tapered_spandrel_tool(from, from.Translated(frame.inward[0] * leg_lo), from.Translated(frame.inward[1] * leg_lo), to,
                                      to.Translated(frame.inward[0] * leg_hi), to.Translated(frame.inward[1] * leg_hi), kPi - frame.fold, blend_name,
                                      tool, why))
      return nullptr;
    tool.convex = frame.convex;
    // Only the blend face keeps a name: a cap of the tool that ends up as part of a closing face takes that face's name when they are merged.
    for (std::string &name : tool.names)
      if (name.rfind("tool.", 0) == 0) name.clear();
    tools.push_back(std::move(tool));
  }
  naming::Named current = input;
  const double volume_before = volume_of(shape);
  if (!apply_tools(current, tools, why)) return nullptr;
  if (std::any_of(tools.begin(), tools.end(), [](const Tool &tool) { return !tool.convex; })) {
    // The end cap of a fused (concave) blend that ends flush on a closing face stays a face of its own next to it: merge the coplanar faces.
    // Only the faces that came from the tools (they carry no name) may merge: every other edge is kept, so a face split by split_face or an imported
    // coplanar face keeps its name.
    const TopTools_IndexedMapOfShape fused_faces = query::distinct(current.shape, TopAbs_FACE);
    TopTools_MapOfShape cap_edges, keep;
    for (int f = 1; f <= fused_faces.Extent(); ++f)
      if (current.names[static_cast<size_t>(f - 1)].empty())
        for (TopExp_Explorer it(fused_faces(f), TopAbs_EDGE); it.More(); it.Next()) cap_edges.Add(it.Current());
    for (TopExp_Explorer it(current.shape, TopAbs_EDGE); it.More(); it.Next())
      if (!cap_edges.Contains(it.Current())) keep.Add(it.Current());
    ShapeUpgrade_UnifySameDomain unifier(current.shape, Standard_False, Standard_True, Standard_False);
    unifier.KeepShapes(keep);
    unifier.AllowInternalEdges(Standard_False);
    unifier.Build();
    const std::vector<naming::Named> fused{current};
    current = naming::Named{unifier.Shape(), naming::inherit(unifier.Shape(), fused, unifier.History(), "unify")};
  }

  // Corners: chords across the support faces between the contact points at the wall arcs, then the patch over the hole they bound.
  std::vector<std::vector<Wall>> walls(corners.size());
  for (size_t c = 0; c < corners.size(); ++c)
    for (const auto &[edge, stub] : plan.stubs[c])
      walls[c].push_back({corners[c].at.Translated(stub * std::max(0.0, setback_of(static_cast<int>(c), edge))), stub});
  TopTools_IndexedDataMapOfShapeListOfShape cut_vertex_faces;
  TopExp::MapShapesAndAncestors(current.shape, TopAbs_VERTEX, TopAbs_FACE, cut_vertex_faces);
  TopTools_ListOfShape chords;
  for (size_t c = 0; c < corners.size(); ++c) {
    std::vector<TopoDS_Vertex> ends;
    for (const Wall &wall : walls[c]) {
      const TopoDS_Edge arc = arc_of(wall_in(current.shape, wall, vertex_tolerance));
      if (arc.IsNull()) {
        why = std::string(kFailed) + "the blend end at " + where(wall.point) + " was not found after the cut";
        return nullptr;
      }
      TopoDS_Vertex a, b;
      TopExp::Vertices(arc, a, b);
      ends.push_back(a);
      ends.push_back(b);
    }
    const TopoDS_Vertex apex = vertex_at(current.shape, corners[c].at, vertex_tolerance);
    if (apex.IsNull()) {
      why = std::string(kFailed) + "the vertex " + where(corners[c].at) + " is gone after the cut";
      return nullptr;
    }
    for (TopTools_ListIteratorOfListOfShape it(cut_vertex_faces.FindFromKey(apex)); it.More(); it.Next()) {
      std::vector<TopoDS_Vertex> on_face;
      for (const TopoDS_Vertex &end : ends)
        if (listed(cut_vertex_faces.FindFromKey(end), it.Value())) on_face.push_back(end);
      if (on_face.size() != 2) {
        why = std::string(kFailed) + "a face at " + where(corners[c].at) + " touches " + std::to_string(on_face.size()) + " blend ends (2 expected)";
        return nullptr;
      }
      BRepBuilderAPI_MakeEdge chord(on_face[0], on_face[1]);
      if (!chord.IsDone()) {
        why = std::string(kFailed) + "the chord across a face at " + where(corners[c].at) + " could not be made";
        return nullptr;
      }
      chords.Append(chord.Edge());
    }
  }
  BRepAlgoAPI_Splitter splitter;
  TopTools_ListOfShape arguments;
  arguments.Append(current.shape);
  splitter.SetArguments(arguments);
  splitter.SetTools(chords);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) {
    why = std::string(kFailed) + "the support faces could not be split along the corner chords";
    return nullptr;
  }
  const TopoDS_Shape split = splitter.Shape();
  const std::vector<naming::Named> inputs{current};
  const std::vector<std::string> split_names = naming::inherit(split, inputs, naming::history_of(inputs, splitter), "boolean");
  TopTools_IndexedMapOfShape split_faces = query::distinct(split, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape split_vertex_faces, split_edge_faces;
  TopExp::MapShapesAndAncestors(split, TopAbs_VERTEX, TopAbs_FACE, split_vertex_faces);
  TopExp::MapShapesAndAncestors(split, TopAbs_EDGE, TopAbs_FACE, split_edge_faces);

  TopTools_IndexedMapOfShape dropped;
  std::vector<TopoDS_Face> patches;
  std::vector<std::string> patch_names;
  for (size_t c = 0; c < corners.size(); ++c) {
    TopTools_IndexedMapOfShape removed;
    const TopoDS_Vertex apex = vertex_at(split, corners[c].at, vertex_tolerance);
    if (apex.IsNull()) {
      why = std::string(kFailed) + "the vertex " + where(corners[c].at) + " is gone after the split";
      return nullptr;
    }
    for (TopTools_ListIteratorOfListOfShape it(split_vertex_faces.FindFromKey(apex)); it.More(); it.Next()) removed.Add(it.Value());
    for (const Wall &wall : walls[c]) {
      const TopoDS_Face face = wall_in(split, wall, vertex_tolerance);
      if (!face.IsNull()) removed.Add(face);
    }
    std::vector<TopoDS_Edge> boundary;
    std::vector<TopoDS_Face> supports;
    TopTools_IndexedMapOfShape seen;
    for (int f = 1; f <= removed.Extent(); ++f)
      for (TopExp_Explorer it(removed(f), TopAbs_EDGE); it.More(); it.Next()) {
        if (!seen.Add(it.Current())) continue;
        for (TopTools_ListIteratorOfListOfShape owner(split_edge_faces.FindFromKey(it.Current())); owner.More(); owner.Next())
          if (removed.FindIndex(owner.Value()) == 0) {
            boundary.push_back(TopoDS::Edge(it.Current()));
            supports.push_back(TopoDS::Face(owner.Value()));
          }
      }
    const size_t expected = 2 * plan.stubs[c].size();
    const std::vector<TopoDS_Edge> loop = boundary.size() == expected ? loop_of(boundary) : std::vector<TopoDS_Edge>();
    if (loop.size() != expected) {
      why = std::string(kFailed) + "the hole at " + where(corners[c].at) + " is bounded by " + std::to_string(boundary.size()) +
            " edge(s) that do not close one loop (" + std::to_string(expected) + " expected)";
      return nullptr;
    }
    // Both tolerances follow the corner: the 3D one is the sewing tolerance but never more than 1e-4 x the smallest setback, the
    // parametric one a fraction of the setback (a fixed value made the fill of a large part slow and a small corner on a large part coarse).
    double smallest = 1e300;
    for (const auto &entry : corners[c].setbacks) smallest = std::min(smallest, entry.second);
    const double fill_tolerance_3d = std::min(sewing_tolerance, kFillSetbackFraction * smallest);
    const double fill_tolerance_2d = 1e-5 * smallest / 2;
    // One fill of the hole; false with the reason in `problem` when the patch cannot be used (not built, off its edges, off tangent).
    const auto fill_hole = [&](const FillSetting &setting, TopoDS_Face &patch, double &gap, std::string &problem) {
      BRepOffsetAPI_MakeFilling filling(kFillDegree, setting.points, kFillIterations, Standard_False, fill_tolerance_2d, fill_tolerance_3d, kFillAngle, 0.1,
                                        setting.max_degree, setting.segments);
      for (const TopoDS_Edge &edge : loop) {
        const size_t at = static_cast<size_t>(std::find_if(boundary.begin(), boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) -
                                              boundary.begin());
        filling.Add(edge, supports[at], GeomAbs_G1);
      }
      filling.Build();
      if (!filling.IsDone()) {
        problem = "could not be filled";
        return false;
      }
      patch = TopoDS::Face(filling.Shape());
      gap = 0;
      for (TopExp_Explorer it(patch, TopAbs_EDGE); it.More(); it.Next()) {
        double edge_worst = 0;
        if (!edge_gap(TopoDS::Edge(it.Current()), patch, edge_worst)) {
          problem = "has an edge without a shared parameter on its surface";
          return false;
        }
        gap = std::max(gap, edge_worst);
      }
      if (gap > patch_gap_limit) {
        problem = "misses the blend ends by " + number(gap) + " (limit " + number(patch_gap_limit) + ")";
        return false;
      }
      if (filling.G1Error() > kFillAngle) {
        problem = "leaves its supports by " + number(filling.G1Error()) + " rad (limit " + number(kFillAngle) + ")";
        return false;
      }
      return true;
    };
    TopoDS_Face patch;
    double gap = 0;
    std::string problem;
    bool filled = false;
    for (const FillSetting &setting : kFillSettings) {
      filled = fill_hole(setting, patch, gap, problem);
      if (filled) break;
    }
    if (!filled) {
      fill_failed = true;
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " " + problem;
      return nullptr;
    }
    worst_patch_gap = std::max(worst_patch_gap, gap);
    {
      // A convex corner removes material, a concave one adds it: the centre of the patch lies IN the source solid for the first, OUT of it for the second.
      GProp_GProps props;
      BRepGProp::SurfaceProperties(patch, props);
      BRepClass3d_SolidClassifier classifier(shape);
      classifier.Perform(props.CentreOfMass(), std::max(blend::kInsideTolerance, 1e-9 * diagonal));
      const TopAbs_State expected = plan.concave[c] ? TopAbs_OUT : TopAbs_IN;
      if (classifier.State() != expected) {
        // deliberately not fill_failed: a patch on the wrong side is a logic failure of the construction, a finer fit would not change it
        why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " lies " + (plan.concave[c] ? "inside" : "outside") +
              " the source solid, on the wrong side of a " + (plan.concave[c] ? "concave" : "convex") + " corner";
        return nullptr;
      }
    }
    patches.push_back(patch);
    std::vector<std::string> around;
    for (const int edge : edges_at(vertex_edges, edge_map, plan.vertices[c])) around.push_back(edge_names[static_cast<size_t>(edge)]);
    patch_names.push_back("blend(v:" + joined_names(around) + ")");
    for (int f = 1; f <= removed.Extent(); ++f) dropped.Add(removed(f));
  }

  // Shell: every face that stays plus the patches, sewn.
  BRepBuilderAPI_Sewing sewing(sewing_tolerance);
  std::vector<TopoDS_Face> members;
  std::vector<std::string> member_names;
  for (int f = 1; f <= split_faces.Extent(); ++f) {
    if (dropped.FindIndex(split_faces(f)) != 0) continue;
    members.push_back(TopoDS::Face(split_faces(f)));
    member_names.push_back(static_cast<size_t>(f) <= split_names.size() ? split_names[static_cast<size_t>(f - 1)] : std::string());
  }
  for (size_t p = 0; p < patches.size(); ++p) {
    members.push_back(patches[p]);
    member_names.push_back(patch_names[p]);
  }
  for (const TopoDS_Face &face : members) sewing.Add(face);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  TopoDS_Shell shell;
  for (TopExp_Explorer it(sewn, TopAbs_SHELL); it.More() && shell.IsNull(); it.Next()) shell = TopoDS::Shell(it.Current());
  if (shell.IsNull() && sewn.ShapeType() == TopAbs_SHELL) shell = TopoDS::Shell(sewn);
  if (shell.IsNull() || sewing.NbFreeEdges() > 0) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing)";
    return nullptr;
  }
  // A void sews into a shell of its own: it becomes an inner shell of the solid (a second body outside the first is refused by name).
  std::string shells_why;
  TopoDS_Solid solid = blend::solid_of_shells(sewn, shells_why);
  if (solid.IsNull() && !shells_why.empty()) {
    why = std::string(kUnsupported) + "a corner blend cannot hold the sewn shells in one solid: " + shells_why;
    return nullptr;
  }
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = std::string(kFailed) + "the blended solid fails the BRepCheck validity analysis";
    return nullptr;
  }
  // A fillet can lower an extreme and shrink the box: the patch gap is judged against the smaller diagonal, so check_blends never reads more.
  const double accepted = blend::kGapAccepted * kPatchGapFraction * std::min(diagonal, lower_diagonal(members, patches.size()));
  if (worst_patch_gap > accepted) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches miss the blend ends by " + number(worst_patch_gap) + " (limit " + number(accepted) +
          " = 0.95 x 5e-6 x the smaller of the source's diagonal and the lower bound of the result's box)";
    return nullptr;
  }
  const double volume_after = volume_of(solid);
  // Convex corners remove material, concave ones add it; a step with both only has to leave a solid.
  const size_t concave_corners = static_cast<size_t>(std::count(plan.concave.begin(), plan.concave.end(), true));
  const bool moved_wrongly = concave_corners == 0 ? !(volume_after < volume_before) : (concave_corners == plan.concave.size() ? !(volume_after > volume_before) : false);
  if (!(volume_after > 0) || moved_wrongly) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches left a solid of volume " + number(volume_after) + " (source " + number(volume_before) + ")";
    return nullptr;
  }
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  std::vector<std::string> names(static_cast<size_t>(final_faces.Extent()));
  for (size_t m = 0; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    const int index = final_faces.FindIndex(image);
    if (index > 0) names[static_cast<size_t>(index - 1)] = member_names[m];
  }
  return naming::wrap_named(solid, names);
}

}  // namespace

std::unique_ptr<Shape> fillet_setback(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners) {
  std::string why;
  try {
    bool fill_failed = false;
    std::string log;
    return build_setback(shape, edges, corners, Mode{}, fill_failed, log, why);
  } catch (const Standard_Failure &) {
    return nullptr;
  }
}

rust::String setback_reason(const Shape &shape, rust::Slice<const double> edges, rust::Slice<const double> corners) {
  std::string why;
  std::unique_ptr<Shape> built;
  try {
    bool fill_failed = false;
    std::string log;
    built = build_setback(shape, edges, corners, Mode{}, fill_failed, log, why);
  } catch (const Standard_Failure &error) {
    why = std::string(kFailed) + "OCCT failed: " + (error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure");
  }
  return rust::String(built ? std::string() : (why.empty() ? std::string(kFailed) + "the setback corner blend failed" : why));
}

namespace blend {

std::unique_ptr<Shape> profile_corner_blend(const Shape &source, const std::vector<std::pair<int, double>> &radii, int kind, double param,
                                            std::string &notes, std::string &why) {
  std::vector<double> flat;
  for (const auto &[edge, radius] : radii) flat.insert(flat.end(), {static_cast<double>(edge), radius, radius});
  std::unique_ptr<Shape> built;
  std::string tried;
  for (const double factor : kAutomaticFactors) {
    bool fill_failed = false;
    std::string corners_json;
    built = build_setback(source, rust::Slice<const double>(flat.data(), flat.size()), rust::Slice<const double>(), Mode{kind, param, true, factor}, fill_failed, corners_json, why);
    if (built) {
      JsonWriter out;
      out.begin_object().key("builder").string("corners").key("factor").number(factor).key("corners").raw(corners_json).end_object();
      notes = out.text();
      return built;
    }
    // Only a patch that cannot be filled within the limits is worth another size; any other failure is the same at every size.
    tried += (tried.empty() ? "" : ", ") + number(factor);
    if (!fill_failed) break;
  }
  // The corner is the profile's, not a setback the caller asked for: the setback codes do not apply.
  if (why.size() > 2 && why[0] == '[') why = why.substr(why.find("] ") + 2);
  why += " (setbacks of " + tried + " x the least distance were tried)";
  return nullptr;
}

}  // namespace blend

}  // namespace llull

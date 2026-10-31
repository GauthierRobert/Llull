// Setback corners (BLD M3, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.5, §13.10, §13.12). Scope of this build: every edge that meets a setback vertex is a
// STRAIGHT edge between two PLANAR faces, all convex (the blends remove material) or all concave (they add it) at one vertex, rounded in the same step with a circular
// radius that is constant or linear between the two ends of the edge; each rounded edge ends at a setback vertex (the other end of an edge may be free: it ends on one
// flat face). The edge blends are the spandrel prisms of blend_profile.cxx (a ruled loft of two sections when the radius tapers), each stopping at the section plane
// `setback` away from its vertex; the sharp stubs and the flat end walls that leave at the vertex are then replaced by a patch (BRepOffsetAPI_MakeFilling, G1 to the
// blend ends and to the support faces along straight chords between the contact points), sewn into a solid.
// A reason that starts with "[CODE] " carries the stable BLD_* code it maps to.
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <exception>
#include <new>
#include <system_error>
#include <thread>
#include <tuple>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <gp_Lin.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <ChFi3d_FilletShape.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakeFilling.hxx>
#include <BRep_Tool.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
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

#include "llull-kernel-occt/cpp/blend_corner_exact.hxx"
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
// A mixed corner (13.18) is judged by the angle measured at the boundary samples, as check_blends does, with a margin under its 0.01 default.
constexpr double kMixedFillAngle = 0.0095;
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
  std::vector<bool> concave;                        // per corner: ALL its edges are concave (the blends add material), else convex (they remove it)
  std::vector<bool> mixed;                          // per corner: convex and concave edges meet (material on both sides of the patch, 13.18)
  // per corner: the faces at the vertex that are reflex there (the sector of the face between its two rounded edges exceeds pi): the plane of the face
  // (outward normal) and the point Q where the contact lines of its two blends meet; the hole is bounded there by P_a -> Q -> P_b instead of a chord (13.18.2)
  struct Reflex {
    TopoDS_Face face;       // the source face (identity of the record)
    gp_Vec normal;
    gp_Pnt q;
    int edge_a, edge_b;     // the two rounded edges that bound the face at the vertex
    double along_a, along_b;  // the position of Q along the stubs of a and b (negative: behind the vertex)
    gp_Vec inward_a, inward_b;
    double offset_a, offset_b, slope_a, slope_b;
  };
  std::vector<std::vector<Reflex>> reflex;
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
  plan.concave.push_back(concave_edges == static_cast<int>(incident.size()));
  plan.mixed.push_back(concave_edges != 0 && concave_edges != static_cast<int>(incident.size()));
  plan.reflex.emplace_back();
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
    // the sector of the face between the two stubs, swept from a to b THROUGH the face (13.18.1): a is the edge from which the face lies counterclockwise seen from outside
    const TopoDS_Face face = TopoDS::Face(it.Value());
    const gp_Vec normal = outward_normal(shape, face);
    const auto inward_in = [&](int edge) {
      const EdgeFrame &frame = plan.frames.at(edge);
      return frame.faces[0].IsSame(face) ? frame.inward[0] : frame.inward[1];
    };
    int i = on_face[0], j = on_face[1];
    if (stub[i].Crossed(inward_in(i)).Dot(normal) < 0) std::swap(i, j);
    const double cosine = stub[i].Dot(stub[j]);
    const double sine = stub[i].Crossed(stub[j]).Dot(normal);  // signed: negative when the face is reflex at the vertex
    if (std::fabs(sine) < 1e-6) {
      why = std::string(kUnsupported) + "two edges leave " + where(corner.at) + " along one line";
      return false;
    }
    if (sine < 0) {
      // a reflex face asks for no setback (Q lies behind the vertex): its pair adds no term and no least-setback constraint, the hole is bounded through Q (13.18.2)
      const gp_Vec u = stub[i] + inward_in(i) * slope.at(i), v = stub[j] + inward_in(j) * slope.at(j);
      const gp_Vec rhs = inward_in(j) * offset.at(j) - inward_in(i) * offset.at(i);
      const double determinant = u.Crossed(v).Dot(normal);
      if (!(std::fabs(determinant) > 1e-9 * u.Magnitude() * v.Magnitude())) {
        why = std::string(kUnsupported) + "the contact lines of the two blends on the reflex face at " + where(corner.at) + " are parallel: no point Q to close the hole through";
        return false;
      }
      const double along = rhs.Crossed(v).Dot(normal) / determinant;
      const double along_b = -u.Crossed(rhs).Dot(normal) / determinant;
      if (!std::isfinite(along) || !std::isfinite(along_b)) {
        why = std::string(kUnsupported) + "the contact lines of the two blends on the reflex face at " + where(corner.at) + " meet nowhere that can be computed";
        return false;
      }
      const gp_Pnt through = corner.at.Translated(u * along + inward_in(i) * offset.at(i));
      // the faces at a vertex are listed once per edge that meets it: one record per face
      if (std::none_of(plan.reflex.back().begin(), plan.reflex.back().end(), [&](const Plan::Reflex &known) { return known.face.IsSame(face); }))
        plan.reflex.back().push_back({face, normal.Normalized(), through, i, j, along, along_b, inward_in(i), inward_in(j), offset.at(i), offset.at(j), slope.at(i), slope.at(j)});
      continue;
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
  // Q must be where the construction assumes it: in the face, in front of the contact points along the edges (a taper can bring it forward of the setback), and the path P_a -> Q -> P_b
  // inside the face. A narrow reflex face (the sector near 2 pi) sends Q to r / sin(phi / 2), far outside it.
  for (const Plan::Reflex &record : plan.reflex.back()) {
    const double reach_a = distance.at(record.edge_a), reach_b = distance.at(record.edge_b);
    const gp_Pnt contact_a = corner.at.Translated(stub.at(record.edge_a) * reach_a + record.inward_a * (record.offset_a + record.slope_a * reach_a));
    const gp_Pnt contact_b = corner.at.Translated(stub.at(record.edge_b) * reach_b + record.inward_b * (record.offset_b + record.slope_b * reach_b));
    // five points along each segment of the path (the ends included are Q and the contact points)
    const auto along_path = [&](const gp_Pnt &from, const gp_Pnt &to) {
      for (int k = 1; k <= 5; ++k) {
        const double f = k / 6.0;
        if (!inside(record.face, gp_Pnt(from.X() + f * (to.X() - from.X()), from.Y() + f * (to.Y() - from.Y()), from.Z() + f * (to.Z() - from.Z())))) return false;
      }
      return true;
    };
    if (record.along_a >= reach_a || record.along_b >= reach_b || !inside(record.face, record.q) || !along_path(contact_a, record.q) || !along_path(record.q, contact_b)) {
      why = std::string(kUnsupported) + "the path across the reflex face at " + where(corner.at) + " (through the point " + where(record.q) +
            " where the contact lines of its two blends meet) leaves the face or ends before the setback: " +
            "this face is too narrow or the radius too steep for the corner patch";
      return false;
    }
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

// Largest angle between the normal of `patch` and the normal of the support face along each edge of `loop` (the hole boundary, `supports` aligned with `boundary`), at
// kGapSamples + 1 samples of the 3D curve (as many as check_blends reads). The patch edges are not the edges of the loop: each loop edge is matched to the patch edge that passes
// through its middle, and a sample is located on that edge by a 1D projection, whose curve on the patch gives the parameters (a projection on the patch itself costs seconds on a
// patch of thousands of poles). The angle is of the normal LINES (a fit that is tangent to the wrong side reads 0 here, and is caught by the oriented check after the sewing,
// `oriented_patch_angle`). FAILS CLOSED: false unless every edge of the loop was matched and at least 95 % of its samples measured.
bool boundary_angle(const TopoDS_Face &patch, const std::vector<TopoDS_Edge> &loop, const std::vector<TopoDS_Edge> &boundary,
                    const std::vector<TopoDS_Face> &supports, double match_distance, double &worst) {
  const BRepAdaptor_Surface patch_surface(patch, Standard_False);
  struct PatchEdge {
    Handle(Geom_Curve) curve;
    Handle(Geom2d_Curve) on_patch;
    double first = 0, last = 0;
  };
  std::vector<PatchEdge> candidates;
  for (TopExp_Explorer it(patch, TopAbs_EDGE); it.More(); it.Next()) {
    PatchEdge candidate;
    double pcurve_first = 0, pcurve_last = 0;
    candidate.curve = BRep_Tool::Curve(TopoDS::Edge(it.Current()), candidate.first, candidate.last);
    candidate.on_patch = BRep_Tool::CurveOnSurface(TopoDS::Edge(it.Current()), patch, pcurve_first, pcurve_last);
    if (!candidate.curve.IsNull() && !candidate.on_patch.IsNull()) candidates.push_back(candidate);
  }
  worst = 0;
  for (const TopoDS_Edge &edge : loop) {
    const size_t at = static_cast<size_t>(std::find_if(boundary.begin(), boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) - boundary.begin());
    if (at >= boundary.size()) return false;
    double first = 0, last = 0;
    const Handle(Geom2d_Curve) on_support = BRep_Tool::CurveOnSurface(edge, supports[at], first, last);
    if (on_support.IsNull()) return false;
    const BRepAdaptor_Curve curve(edge);
    const BRepAdaptor_Surface support_surface(supports[at], Standard_False);
    const gp_Pnt middle = curve.Value(0.5 * (first + last));
    const PatchEdge *match = nullptr;
    double nearest = match_distance;
    for (const PatchEdge &candidate : candidates) {
      const GeomAPI_ProjectPointOnCurve probe(middle, candidate.curve, candidate.first, candidate.last);
      if (probe.NbPoints() > 0 && probe.LowerDistance() < nearest) {
        nearest = probe.LowerDistance();
        match = &candidate;
      }
    }
    if (match == nullptr) return false;
    int measured = 0;
    for (int k = 0; k <= kGapSamples; ++k) {
      const double t = first + (last - first) * k / static_cast<double>(kGapSamples);
      const GeomAPI_ProjectPointOnCurve located(curve.Value(t), match->curve, match->first, match->last);
      if (located.NbPoints() < 1) continue;
      const gp_Pnt2d uv_s = on_support->Value(t), uv_p = match->on_patch->Value(located.LowerDistanceParameter());
      gp_Pnt point;
      gp_Vec eu, ev, du, dv;
      support_surface.D1(uv_s.X(), uv_s.Y(), point, eu, ev);
      patch_surface.D1(uv_p.X(), uv_p.Y(), point, du, dv);
      const gp_Vec n = du.Crossed(dv), m = eu.Crossed(ev);
      if (n.Magnitude() < 1e-14 || m.Magnitude() < 1e-14) continue;
      ++measured;
      const double angle = n.Angle(m);
      worst = std::max(worst, angle > kPi / 2 ? kPi - angle : angle);
    }
    if (measured < 0.95 * (kGapSamples + 1)) return false;
  }
  return true;
}

// The ORIENTED check of a patch in the sewn solid: along every edge of the patch image the outward normals of the patch and of the face on the other side (the face orientation applied
// to both) must agree within kMixedFillAngle. A patch folded to the wrong side, or a surface tangent to its neighbour but facing the other way, reads about pi here and fails; false with the
// worst angle (pi for an unmeasured edge) otherwise.
bool oriented_patch_angle(const TopoDS_Face &patch, const TopTools_IndexedDataMapOfShapeListOfShape &edge_faces, double &worst, bool tangent_edges_only = false) {
  worst = 0;
  for (TopExp_Explorer it(patch, TopAbs_EDGE); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Current());
    if (BRep_Tool::Degenerated(edge)) continue;
    if (!edge_faces.Contains(edge)) {
      worst = kPi;
      return false;
    }
    std::vector<TopoDS_Face> sides;
    for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(edge)); owner.More(); owner.Next()) sides.push_back(TopoDS::Face(owner.Value()));
    if (sides.size() != 2) {
      worst = kPi;
      return false;
    }
    std::vector<std::pair<Handle(Geom2d_Curve), std::pair<double, double>>> curves;
    for (const TopoDS_Face &side : sides) {
      double first = 0, last = 0;
      const Handle(Geom2d_Curve) on_side = BRep_Tool::CurveOnSurface(edge, side, first, last);
      if (on_side.IsNull()) {
        worst = kPi;
        return false;
      }
      curves.push_back({on_side, {first, last}});
    }
    double edge_worst = 0;
    for (int k = 0; k <= kGapSamples; ++k) {
      const double fraction = static_cast<double>(k) / kGapSamples;
      gp_Vec normals[2];
      for (size_t side = 0; side < 2; ++side) {
        const gp_Pnt2d uv = curves[side].first->Value(curves[side].second.first + (curves[side].second.second - curves[side].second.first) * fraction);
        gp_Pnt point;
        gp_Vec du, dv;
        BRepAdaptor_Surface(sides[side], Standard_False).D1(uv.X(), uv.Y(), point, du, dv);
        gp_Vec normal = du.Crossed(dv);
        if (normal.Magnitude() < 1e-14 && (k == 0 || k == kGapSamples)) {
          // the pole of an exact corner star (13.21), at an END of the edge only: the normal just inside it
          const double inside = fraction < 0.5 ? 1e-4 : 1.0 - 1e-4;
          const gp_Pnt2d shifted = curves[side].first->Value(curves[side].second.first + (curves[side].second.second - curves[side].second.first) * inside);
          BRepAdaptor_Surface(sides[side], Standard_False).D1(shifted.X(), shifted.Y(), point, du, dv);
          normal = du.Crossed(dv);
        }
        if (normal.Magnitude() < 1e-14) {
          worst = kPi;
          return false;
        }
        normal.Normalize();
        normals[side] = sides[side].Orientation() == TopAbs_REVERSED ? normal.Reversed() : normal;
      }
      edge_worst = std::max(edge_worst, normals[0].Angle(normals[1]));
    }
    // (probe only) an edge where the faces meet at a corner is not a tangent edge: the seam of a test shape
    if (tangent_edges_only && std::min(edge_worst, kPi - edge_worst) > 0.5) continue;
    worst = std::max(worst, edge_worst);
  }
  return worst <= kMixedFillAngle;
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

// One corner's fill, with everything it needs OWNED by the job (the faces and edges are copies made on the building thread: no TopoDS handle is shared between threads, so OCCT's reference
// counts and caches are never touched concurrently, 13.20) and everything it produces. The fit settings are tried in turn until a patch passes.
struct FillJob {
  size_t corner = 0;
  std::string hole_error;                 // the hole could not be isolated: reported in corner order, by the serial finish
  std::vector<TopoDS_Shape> removed;      // the faces of the split solid that the patch replaces
  std::vector<TopoDS_Edge> loop, boundary;  // copies
  std::vector<TopoDS_Face> supports;        // copies, aligned with `boundary`
  double tolerance_3d = 0, tolerance_2d = 0;
  bool mixed = false;
  // results
  TopoDS_Face patch;                  // the MakeFilling patch
  std::vector<TopoDS_Face> patches;   // what replaces the hole: the exact star (13.21) or the MakeFilling patch
  gp_Pnt centre;                      // the centre of the exact star
  bool has_centre = false;
  std::string exact_problem;          // why the exact star was refused
  TopoDS_Compound hole_copy;          // a copy of the faces the patch replaces, when they are a smooth surface that knows its centre (13.22)
  bool allow_star = true;             // false: the plate only (the star failed after the sewing)
  std::vector<size_t> patch_part;     // 1 when the sub-patch starts inside that loop edge
  std::vector<size_t> patch_loop;     // the loop edge each sub-patch of a star has as its bottom (empty for the plate patch)
  std::vector<std::tuple<std::string, long long, long long, long long>> loop_keys;  // aligned with `loop`: the stable order of the sub-patches (13.21.2)
  double gap = 0;
  std::string problem;
  bool filled = false;
  std::exception_ptr error;  // whatever a worker threw (OCCT or std::bad_alloc): rethrown at this corner by the serial finish, as a serial build would have thrown it
};

// One fill of the hole of `job` with `setting`; false with the reason in job.problem when the patch cannot be used (not built, off its edges, off tangent).
bool fill_hole(FillJob &job, const FillSetting &setting, double patch_gap_limit, double diagonal) {
  BRepOffsetAPI_MakeFilling filling(kFillDegree, setting.points, kFillIterations, Standard_False, job.tolerance_2d, job.tolerance_3d, kFillAngle, 0.1, setting.max_degree,
                                    setting.segments);
  for (const TopoDS_Edge &edge : job.loop) {
    const size_t at = static_cast<size_t>(std::find_if(job.boundary.begin(), job.boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) - job.boundary.begin());
    filling.Add(edge, job.supports[at], GeomAbs_G1);
  }
  filling.Build();
  if (!filling.IsDone()) {
    job.problem = "could not be filled";
    return false;
  }
  job.patch = TopoDS::Face(filling.Shape());
  job.gap = 0;
  for (TopExp_Explorer it(job.patch, TopAbs_EDGE); it.More(); it.Next()) {
    double edge_worst = 0;
    if (!edge_gap(TopoDS::Edge(it.Current()), job.patch, edge_worst)) {
      job.problem = "has an edge without a shared parameter on its surface";
      return false;
    }
    job.gap = std::max(job.gap, edge_worst);
  }
  if (job.gap > patch_gap_limit) {
    job.problem = "misses the blend ends by " + number(job.gap) + " (limit " + number(patch_gap_limit) + ")";
    return false;
  }
  if (job.mixed) {
    double angle = 0;
    if (!boundary_angle(job.patch, job.loop, job.boundary, job.supports, 1e-4 * diagonal, angle)) {
      job.problem = "has a boundary that could not be measured against its supports (an edge not matched, or too few samples)";
      return false;
    }
    if (angle > kMixedFillAngle) {
      job.problem = "leaves its supports by " + number(angle) + " rad at the boundary samples (limit " + number(kMixedFillAngle) + ")";
      return false;
    }
  }
  if (filling.G1Error() > kFillAngle) {
    job.problem = "leaves its supports by " + number(filling.G1Error()) + " rad (limit " + number(kFillAngle) + ")";
    return false;
  }
  return true;
}

std::atomic<int> g_corner_threads{0};  // 0: LLULL_CORNER_THREADS, else the hardware (test hook: set_corner_threads)
std::atomic<int> g_last_threads{0};    // the threads the last fill_all used (test hook: last_corner_threads)
std::atomic<int> g_fault_corner{-1};   // test hook: the corner whose fill throws std::bad_alloc
std::atomic<int> g_exact_mode{1};           // test hook: set_corner_exact_patch (0: MakeFilling only, 1: the exact star first, 2: the exact star is refused, 3 / 4: a step fails after the fills, 5: no plate fallback)
std::atomic<bool> g_force_trim{false};   // test hook: set_corner_trim (the rolling-ball trim builder for every step, 13.22)
std::atomic<int> g_spawn_limit{-1};    // test hook: the worker whose creation fails

// The key that orders the sub-patches of a star independently of where the loop starts: the name of the support the loop edge lies on, then its middle rounded to the sewing tolerance.
std::tuple<std::string, long long, long long, long long> loop_key(const TopoDS_Edge &edge, const std::string &support_name, double quantum) {
  const BRepAdaptor_Curve curve(edge);
  const gp_Pnt middle = curve.Value(0.5 * (curve.FirstParameter() + curve.LastParameter()));
  return {support_name, std::llround(middle.X() / quantum), std::llround(middle.Y() / quantum), std::llround(middle.Z() / quantum)};
}

// The exact star of 13.21 first (G0 to the default 1e-6 x the diagonal, a fifth of it here); MakeFilling when it is refused, with the reason kept for the message.
bool fill_exact(FillJob &job, double diagonal) {
  if (g_exact_mode.load() == 2) {
    job.exact_problem = "refused by the test hook";
    return false;
  }
  std::vector<TopoDS_Face> aligned;
  for (const TopoDS_Edge &edge : job.loop) {
    const auto at = std::find_if(job.boundary.begin(), job.boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); });
    if (at == job.boundary.end()) {
      job.exact_problem = "an edge of the hole is not in its boundary";
      return false;
    }
    aligned.push_back(job.supports[static_cast<size_t>(at - job.boundary.begin())]);
  }
  corner_exact::Patches exact;
  corner_exact::CentreHint hint;
  if (!job.hole_copy.IsNull())
    hint = [&job, diagonal](const gp_Pnt &from, const gp_Dir &axis, double &height) {
      IntCurvesFace_ShapeIntersector intersector;
      intersector.Load(job.hole_copy, 1e-7);
      intersector.Perform(gp_Lin(from, axis), -diagonal, diagonal);
      double best = 1e300;
      for (int i = 1; i <= intersector.NbPnt(); ++i)
        if (std::fabs(intersector.WParameter(i)) < best) {
          best = std::fabs(intersector.WParameter(i));
          height = intersector.WParameter(i);
        }
      return best < 1e299;
    };
  if (!corner_exact::build(job.loop, aligned, 0.2e-6 * diagonal, kMixedFillAngle, exact, job.exact_problem, hint)) return false;
  job.patches = exact.faces;
  job.patch_loop = exact.loop_index;
  job.patch_part = exact.part;
  job.centre = exact.centre;
  job.has_centre = true;
  job.gap = exact.gap;
  return true;
}

void fill_corner(FillJob &job, double patch_gap_limit, double diagonal) {
  try {
    if (g_fault_corner.load() == static_cast<int>(job.corner)) throw std::bad_alloc();
    if (job.allow_star && g_exact_mode.load() != 0 && fill_exact(job, diagonal)) {
      job.filled = true;
      return;
    }
    if (g_exact_mode.load() == 5 && !job.exact_problem.empty()) {
      job.problem = "was not filled: the exact-boundary patch was refused: " + job.exact_problem;  // test hook 5: no fallback, the reason is the message
      return;
    }
    for (const FillSetting &setting : kFillSettings) {
      job.filled = fill_hole(job, setting, patch_gap_limit, diagonal);
      if (job.filled) {
        job.patches = {job.patch};
        return;
      }
    }
    if (!job.exact_problem.empty()) job.problem += " (the exact-boundary patch was refused: " + job.exact_problem + ")";
  } catch (...) {
    job.filled = false;
    job.error = std::current_exception();
  }
}

// The number of threads the fills of `jobs` run on: the override, else LLULL_CORNER_THREADS, else the hardware, at most 8 and at most one per job; per call. The result of a build does not
// depend on it (the jobs are independent and the finish is serial, in corner order).
size_t corner_threads(size_t jobs) {
  long wanted = g_corner_threads.load();
  if (wanted <= 0)
    if (const char *text = std::getenv("LLULL_CORNER_THREADS")) wanted = std::atol(text);
  if (wanted <= 0) wanted = static_cast<long>(std::thread::hardware_concurrency());
  return static_cast<size_t>(std::max(1L, std::min({wanted, 8L, static_cast<long>(jobs)})));
}

// Joins every started worker, whatever leaves the scope (a failed thread creation included).
struct Workers {
  std::vector<std::thread> started;
  ~Workers() {
    for (std::thread &worker : started)
      if (worker.joinable()) worker.join();
  }
};

// The fills run on the calling thread and on threads - 1 workers; when a worker cannot be created the others (the calling thread included) take its jobs. A failing corner is final (the serial
// finish stops at the first one, in corner order): the jobs above the least failed position are skipped.
void fill_all(std::vector<FillJob> &jobs, double patch_gap_limit, double diagonal) {
  std::vector<size_t> todo;
  for (size_t j = 0; j < jobs.size(); ++j) {
    if (!jobs[j].hole_error.empty()) break;  // the finish stops at the first hole that is not isolated: nothing after it is read
    todo.push_back(j);
  }
  const size_t threads = corner_threads(todo.size());
  g_last_threads.store(static_cast<int>(threads));
  std::atomic<size_t> next{0};
  std::atomic<size_t> first_failed{todo.size()};
  const auto work = [&]() {
    for (size_t at = next.fetch_add(1); at < todo.size(); at = next.fetch_add(1)) {
      if (at > first_failed.load()) continue;
      fill_corner(jobs[todo[at]], patch_gap_limit, diagonal);
      if (jobs[todo[at]].filled) continue;
      size_t seen = first_failed.load();
      while (at < seen && !first_failed.compare_exchange_weak(seen, at)) {
      }
    }
  };
  Workers workers;
  try {
    for (size_t t = 0; t + 1 < threads; ++t) {
      if (g_spawn_limit.load() >= 0 && static_cast<int>(t) >= g_spawn_limit.load()) throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));
      workers.started.emplace_back(work);
    }
  } catch (const std::system_error &) {
  }
  work();
}

// ---- Setback corners on curved edges and faces: the rolling-ball trim (13.22) ----

// Whether unique edge `index` is not a straight line between two planar faces: the analytic builder (prisms, chords) cannot take it.
bool edge_needs_trim(const TopTools_IndexedMapOfShape &edge_map, const TopTools_IndexedDataMapOfShapeListOfShape &owners, int index) {
  if (index < 0 || index >= edge_map.Extent()) return false;
  const TopoDS_Edge edge = TopoDS::Edge(edge_map(index + 1));
  if (BRepAdaptor_Curve(edge).GetType() != GeomAbs_Line) return true;
  if (!owners.Contains(edge)) return false;
  for (TopTools_ListIteratorOfListOfShape it(owners.FindFromKey(edge)); it.More(); it.Next())
    if (BRepAdaptor_Surface(TopoDS::Face(it.Value()), Standard_False).GetType() != GeomAbs_Plane) return true;
  return false;
}

// How the step is built: 0 the analytic builder (every corner has straight edges between planar faces only), 1 the rolling-ball trim (every corner has a curved edge or face, or the test hook),
// 2 a mixture (refused: the two builders measure the setback differently, along the edge and from the vertex).
int step_kind(const TopoDS_Shape &shape, const std::map<int, Taper> &radius, const std::vector<Corner> &corners, double tolerance) {
  if (g_force_trim.load()) return 1;
  const TopTools_IndexedMapOfShape edge_map = query::distinct(shape, TopAbs_EDGE);
  TopTools_IndexedDataMapOfShapeListOfShape owners, vertex_edges;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, owners);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
  int trimmed = 0, analytic = 0;
  const auto curved = [&](int index) { return edge_needs_trim(edge_map, owners, index); };
  for (const Corner &corner : corners) {
    const TopoDS_Vertex vertex = vertex_at(shape, corner.at, tolerance);
    bool any = false;
    if (!vertex.IsNull())
      for (const int edge : edges_at(vertex_edges, edge_map, vertex)) any = any || curved(edge);
    (any ? trimmed : analytic) += 1;
  }
  if (corners.empty())
    for (const auto &entry : radius) (curved(entry.first) ? trimmed : analytic) += 1;
  return trimmed == 0 ? 0 : (analytic == 0 ? 1 : 2);
}

// Whether a face piece of the split solid lies inside the ball (centre, radius): every edge of it that is not on the sphere has its middle inside, and there is one.
bool piece_inside_ball(const TopoDS_Face &face, const gp_Pnt &centre, double radius) {
  int inside = 0;
  for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Current());
    if (BRep_Tool::Degenerated(edge)) continue;
    const BRepAdaptor_Curve curve(edge);
    const double distance = curve.Value(0.5 * (curve.FirstParameter() + curve.LastParameter())).Distance(centre);
    if (distance > radius * (1 + 1e-6)) return false;
    if (distance < radius * (1 - 1e-6)) ++inside;
  }
  return inside > 0;
}

// Whether a face is a piece of the ball itself (the splitter keeps the part of the tool's sphere that lies inside the solid): the sphere about `centre` of radius `radius`.
bool is_ball_face(const TopoDS_Face &face, const gp_Pnt &centre, double radius) {
  const BRepAdaptor_Surface surface(face, Standard_False);
  return surface.GetType() == GeomAbs_Sphere && surface.Sphere().Location().Distance(centre) < 1e-6 * radius && std::fabs(surface.Sphere().Radius() - radius) < 1e-6 * radius;
}

// The setback corner on edges the analytic builder cannot take (a circle, a B-spline, a cylinder / cone / free-form face): OCCT's rolling-ball blend of the rounded edges, then
// at each corner the faces inside the ball of radius `setback` around the vertex (OCCT's own corner) are cut away and the hole they leave is filled by the exact star (13.21; the plate when the star is refused).
std::unique_ptr<Shape> build_trimmed(const Shape &source, const std::map<int, Taper> &radius, const std::vector<Corner> &corners, bool &fill_failed,
                                     std::string &corners_json, std::string &why, bool allow_star, bool &star_used) {
  const TopoDS_Shape &shape = source.shape;
  const double diagonal = blend::diagonal_of(shape);
  const double sewing_tolerance = std::max(1e-6 * diagonal, 1e-12);
  const double patch_gap_limit = blend::kGapAccepted * kPatchGapFraction * diagonal;
  for (const auto &[index, taper] : radius)
    if (!taper.constant()) {
      why = std::string(kUnsupported) + "a radius that varies along edge " + std::to_string(index) + " is not made at a corner on a curved edge or face (constant radius only)";
      return nullptr;
    }
  std::vector<double> reach;
  for (const Corner &corner : corners) {
    double least = 1e300, most = 0;
    for (const auto &entry : corner.setbacks) {
      least = std::min(least, entry.second);
      most = std::max(most, entry.second);
    }
    if (!(least > 0) || most - least > 1e-9 * most) {
      why = std::string(kUnsupported) + "the edges at " + where(corner.at) + " have different setbacks: a corner on a curved edge or face trims at one distance from the vertex";
      return nullptr;
    }
    reach.push_back(most);
  }
  for (size_t a = 0; a < corners.size(); ++a)
    for (size_t b = a + 1; b < corners.size(); ++b)
      if (corners[a].at.Distance(corners[b].at) < reach[a] + reach[b]) {
        why = std::string(kUnsupported) + "the setback distances at " + where(corners[a].at) + " and " + where(corners[b].at) + " overlap";
        return nullptr;
      }
  const double vertex_tolerance = kVertexFraction * std::max(blend::vertex_diagonal_of(shape), 1e-9);
  TopTools_IndexedDataMapOfShapeListOfShape vertex_edges_all, vertex_faces_all;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges_all);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces_all);
  const TopTools_IndexedMapOfShape unique_edges = query::distinct(shape, TopAbs_EDGE);
  // Every edge that meets a setback vertex is rounded in this step, and every rounded edge ends at a setback vertex (the ball must be able to cut the whole of each blend).
  std::vector<TopoDS_Vertex> corner_vertices;
  for (const Corner &corner : corners) {
    const TopoDS_Vertex vertex = vertex_at(shape, corner.at, vertex_tolerance);
    if (vertex.IsNull()) {
      why = std::string(kFailed) + "the solid has no vertex at " + where(corner.at);
      return nullptr;
    }
    corner_vertices.push_back(vertex);
    const std::vector<int> incident = edges_at(vertex_edges_all, unique_edges, vertex);
    if (incident.size() < 3) {
      why = std::string(kUnsupported) + "only " + std::to_string(incident.size()) + " edge(s) meet at " + where(corner.at) + ": a setback corner needs 3 or more";
      return nullptr;
    }
    for (const int edge : incident)
      if (radius.find(edge) == radius.end()) {
        why = std::string(kUnsupported) + "edge " + std::to_string(edge) + " meets the setback vertex " + where(corner.at) +
              " but is not rounded: a setback corner rounds every edge that meets there, in the same step";
        return nullptr;
      }
  }
  for (const auto &entry : radius) {
    if (entry.first < 0 || entry.first >= unique_edges.Extent()) continue;
    const BRepAdaptor_Curve curve(TopoDS::Edge(unique_edges(entry.first + 1)));
    const bool at_corner = std::any_of(corners.begin(), corners.end(), [&](const Corner &corner) {
      return same_point(curve.Value(curve.FirstParameter()), corner.at, vertex_tolerance) || same_point(curve.Value(curve.LastParameter()), corner.at, vertex_tolerance);
    });
    if (!at_corner) {
      why = std::string(kUnsupported) + "edge " + std::to_string(entry.first) + " does not end at a setback vertex: every rounded edge must meet one in this build";
      return nullptr;
    }
  }
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
  const TopTools_IndexedMapOfShape edge_map = query::distinct(shape, TopAbs_EDGE);
  BRepFilletAPI_MakeFillet maker(shape, ChFi3d_Rational);
  for (const auto &[index, taper] : radius) {
    if (index < 0 || index >= edge_map.Extent()) {
      why = std::string(kFailed) + "edge " + std::to_string(index) + " is not an edge of the solid";
      return nullptr;
    }
    maker.Add(taper.start, TopoDS::Edge(edge_map(index + 1)));
  }
  maker.Build();
  if (!maker.IsDone() || maker.Shape().IsNull()) {
    why = std::string(kFailed) + "the rolling-ball blend of the edges at the corners could not be built (OCCT refuses this combination of edges and radii)";
    return nullptr;
  }
  const std::vector<naming::Named> sources{naming::named(source)};
  const std::unique_ptr<Shape> rounded =
      naming::wrap_named(maker.Shape(), naming::inherit(maker.Shape(), sources, naming::history_of(sources, maker), "blend"));
  const naming::Named current = naming::named(*rounded);
  const std::vector<std::string> edge_names = naming::edge_names(shape, sources[0].names);
  TopTools_IndexedDataMapOfShapeListOfShape vertex_edges;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vertex_edges);
  const double volume_rounded = volume_of(current.shape);
  // The ball must hold OCCT's own corner at each vertex (the farthest point of the faces generated at the vertex), and meet no face that does not belong to the vertex.
  const TopTools_IndexedMapOfShape rounded_faces = query::distinct(current.shape, TopAbs_FACE);
  for (size_t c = 0; c < corners.size(); ++c) {
    TopTools_IndexedMapOfShape belonging;
    const auto add_all = [&](const TopTools_ListOfShape &list) {
      for (TopTools_ListIteratorOfListOfShape it(list); it.More(); it.Next()) belonging.Add(it.Value());
    };
    add_all(maker.Generated(corner_vertices[c]));
    double minimum = 0;
    for (TopTools_ListIteratorOfListOfShape it(maker.Generated(corner_vertices[c])); it.More(); it.Next())
      for (TopExp_Explorer vertices(it.Value(), TopAbs_VERTEX); vertices.More(); vertices.Next())
        minimum = std::max(minimum, BRep_Tool::Pnt(TopoDS::Vertex(vertices.Current())).Distance(corners[c].at));
    TopTools_IndexedMapOfShape incident_faces;
    for (TopTools_ListIteratorOfListOfShape faces(vertex_faces_all.FindFromKey(corner_vertices[c])); faces.More(); faces.Next()) incident_faces.Add(faces.Value());
    for (int f = 1; f <= incident_faces.Extent(); ++f) {
      if (maker.Modified(incident_faces(f)).IsEmpty()) belonging.Add(incident_faces(f));
      add_all(maker.Modified(incident_faces(f)));
    }
    for (const int edge : edges_at(vertex_edges_all, unique_edges, corner_vertices[c])) add_all(maker.Generated(unique_edges(edge + 1)));
    if (!(reach[c] > minimum * (1 + 1e-3))) {
      why = std::string(kTooShort) + "the setback ball of radius " + number(reach[c]) + " at " + where(corners[c].at) + " must exceed " + number(minimum) +
            " (the farthest point of the rolling-ball corner there): it would cut the blends inside the corner";
      return nullptr;
    }
    const TopoDS_Vertex centre = BRepBuilderAPI_MakeVertex(corners[c].at);
    for (int f = 1; f <= rounded_faces.Extent(); ++f) {
      if (belonging.Contains(rounded_faces(f))) continue;
      BRepExtrema_DistShapeShape distance(centre, rounded_faces(f));
      if (distance.IsDone() && distance.Value() < reach[c] * (1 + 1e-3)) {
        why = std::string(kUnsupported) + "a face that does not meet the vertex " + where(corners[c].at) + " lies " + number(distance.Value()) +
              " from it, inside or at the setback ball of radius " + number(reach[c]) + ": use a smaller setback";
        return nullptr;
      }
    }
  }
  BRepAlgoAPI_Splitter splitter;
  TopTools_ListOfShape arguments, balls;
  arguments.Append(current.shape);
  for (size_t c = 0; c < corners.size(); ++c) balls.Append(BRepPrimAPI_MakeSphere(corners[c].at, reach[c]).Shape());
  splitter.SetArguments(arguments);
  splitter.SetTools(balls);
  splitter.Build();
  if (!splitter.IsDone() || splitter.HasErrors()) {
    why = std::string(kFailed) + "the blended solid could not be cut by the setback balls";
    return nullptr;
  }
  const TopoDS_Shape split = splitter.Shape();
  const std::vector<naming::Named> inputs{current};
  const std::vector<std::string> split_names = naming::inherit(split, inputs, naming::history_of(inputs, splitter), "boolean");
  const TopTools_IndexedMapOfShape split_faces = query::distinct(split, TopAbs_FACE);
  TopTools_IndexedDataMapOfShapeListOfShape split_edge_faces;
  TopExp::MapShapesAndAncestors(split, TopAbs_EDGE, TopAbs_FACE, split_edge_faces);
  std::vector<FillJob> jobs(corners.size());
  for (size_t c = 0; c < corners.size(); ++c) {
    FillJob &job = jobs[c];
    job.corner = c;
    TopTools_IndexedMapOfShape removed;
    for (int f = 1; f <= split_faces.Extent(); ++f)
      if (!is_ball_face(TopoDS::Face(split_faces(f)), corners[c].at, reach[c]) && piece_inside_ball(TopoDS::Face(split_faces(f)), corners[c].at, reach[c])) removed.Add(split_faces(f));
    for (int f = 1; f <= removed.Extent(); ++f) job.removed.push_back(removed(f));
    std::vector<TopoDS_Edge> boundary;
    std::vector<TopoDS_Face> supports;
    TopTools_IndexedMapOfShape seen;
    for (int f = 1; f <= removed.Extent(); ++f)
      for (TopExp_Explorer it(removed(f), TopAbs_EDGE); it.More(); it.Next()) {
        if (BRep_Tool::Degenerated(TopoDS::Edge(it.Current())) || !seen.Add(it.Current())) continue;
        for (TopTools_ListIteratorOfListOfShape owner(split_edge_faces.FindFromKey(it.Current())); owner.More(); owner.Next())
          if (removed.FindIndex(owner.Value()) == 0 && !is_ball_face(TopoDS::Face(owner.Value()), corners[c].at, reach[c])) {
            boundary.push_back(TopoDS::Edge(it.Current()));
            supports.push_back(TopoDS::Face(owner.Value()));
            break;
          }
      }
    const std::vector<TopoDS_Edge> loop = boundary.empty() ? std::vector<TopoDS_Edge>() : loop_of(boundary);
    if (removed.IsEmpty() || loop.size() != boundary.size()) {
      job.hole_error = std::string(kFailed) + "the ball of radius " + number(reach[c]) + " at " + where(corners[c].at) + " leaves " + std::to_string(boundary.size()) +
                       " boundary edge(s) that do not close one loop";
      continue;
    }
    job.tolerance_3d = std::min(sewing_tolerance, kFillSetbackFraction * reach[c]);
    job.tolerance_2d = 1e-5 * reach[c] / 2;
    BRep_Builder builder;
    TopoDS_Compound shared;
    builder.MakeCompound(shared);
    TopTools_IndexedMapOfShape distinct_supports;
    for (const TopoDS_Face &support : supports)
      if (distinct_supports.Add(support)) builder.Add(shared, support);
    BRepBuilderAPI_Copy copy(shared, Standard_True, Standard_False);
    const auto image = [&copy](const TopoDS_Shape &original) {
      TopoDS_Shape found = copy.ModifiedShape(original);
      found.Orientation(original.Orientation());
      return found;
    };
    {
      BRep_Builder hole_builder;
      TopoDS_Compound hole;
      hole_builder.MakeCompound(hole);
      for (int f = 1; f <= removed.Extent(); ++f) hole_builder.Add(hole, removed(f));
      job.hole_copy = TopoDS::Compound(BRepBuilderAPI_Copy(hole, Standard_True, Standard_False).Shape());
    }
    for (const TopoDS_Edge &edge : boundary) job.boundary.push_back(TopoDS::Edge(image(edge)));
    for (const TopoDS_Face &support : supports) job.supports.push_back(TopoDS::Face(image(support)));
    for (const TopoDS_Edge &edge : loop) {
      job.loop.push_back(TopoDS::Edge(image(edge)));
      const size_t at = static_cast<size_t>(std::find_if(boundary.begin(), boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) - boundary.begin());
      const int support_index = split_faces.FindIndex(supports[at]);
      job.loop_keys.push_back(loop_key(edge, support_index > 0 && static_cast<size_t>(support_index) <= split_names.size() ? split_names[static_cast<size_t>(support_index - 1)] : std::string(),
                                       std::max(1e-6 * diagonal, 1e-12)));
    }
    job.allow_star = allow_star;
  }
  fill_all(jobs, patch_gap_limit, diagonal);
  for (const FillJob &job : jobs) star_used = star_used || !job.patch_loop.empty();
  TopTools_IndexedMapOfShape dropped;
  std::vector<TopoDS_Face> patches;
  std::vector<std::string> patch_names;
  double worst_patch_gap = 0;
  for (size_t c = 0; c < corners.size(); ++c) {
    FillJob &job = jobs[c];
    if (!job.hole_error.empty()) {
      why = job.hole_error;
      return nullptr;
    }
    if (job.error) std::rethrow_exception(job.error);
    if (!job.filled) {
      fill_failed = true;
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " " + job.problem;
      return nullptr;
    }
    worst_patch_gap = std::max(worst_patch_gap, job.gap);
    std::vector<std::string> around;
    const TopoDS_Vertex apex = vertex_at(shape, corners[c].at, kVertexFraction * std::max(blend::vertex_diagonal_of(shape), 1e-9));
    if (!apex.IsNull())
      for (const int edge : edges_at(vertex_edges, edge_map, apex)) around.push_back(edge_names[static_cast<size_t>(edge)]);
    std::vector<size_t> rank(job.patch_loop.size());
    {
      std::vector<size_t> order(job.patch_loop.size());
      for (size_t k = 0; k < order.size(); ++k) order[k] = k;
      const auto key_of = [&](size_t k) { return std::make_pair(job.loop_keys[job.patch_loop[k]], job.patch_part[k]); };
      std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return key_of(a) < key_of(b); });
      for (size_t k = 0; k < order.size(); ++k) rank[order[k]] = k;
    }
    for (size_t k = 0; k < job.patches.size(); ++k) {
      patches.push_back(job.patches[k]);
      patch_names.push_back("blend(v:" + joined_names(around) + ")" + (job.patch_loop.empty() ? std::string() : "#" + std::to_string(rank[k] + 1)));
    }
    for (const TopoDS_Shape &face : job.removed) dropped.Add(face);
  }
  for (int f = 1; f <= split_faces.Extent(); ++f)
    for (size_t c = 0; c < corners.size(); ++c)
      if (is_ball_face(TopoDS::Face(split_faces(f)), corners[c].at, reach[c])) dropped.Add(split_faces(f));
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
  if (sewing.NbFreeEdges() > 0) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches do not close the solid (" + std::to_string(sewing.NbFreeEdges()) + " free edge(s) after sewing)";
    return nullptr;
  }
  std::string shells_why;
  TopoDS_Solid solid = blend::solid_of_shells(sewn, shells_why);
  if (solid.IsNull() || !BRepCheck_Analyzer(solid, Standard_True).IsValid()) {
    why = std::string(kFailed) + "the blended solid fails the BRepCheck validity analysis" + (shells_why.empty() ? std::string() : ": " + shells_why);
    return nullptr;
  }
  const double accepted = blend::kGapAccepted * kPatchGapFraction * std::min(diagonal, lower_diagonal(members, patches.size()));
  if (worst_patch_gap > accepted) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches miss the blend ends by " + number(worst_patch_gap) + " (limit " + number(accepted) + ")";
    return nullptr;
  }
  // The star replaces what is inside the balls: the volume moves by less than the balls hold.
  const double volume_after = volume_of(solid);
  double ball_volume = 0;
  for (size_t c = 0; c < corners.size(); ++c) {
    BRepAlgoAPI_Common common(current.shape, BRepPrimAPI_MakeSphere(corners[c].at, reach[c]).Shape());
    ball_volume += common.IsDone() && !common.Shape().IsNull() ? volume_of(common.Shape()) : 4.0 / 3.0 * kPi * reach[c] * reach[c] * reach[c];
  }
  if (!(volume_after > 0) || std::fabs(volume_after - volume_rounded) > ball_volume) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches left a solid of volume " + number(volume_after) + " (rolling-ball blend " + number(volume_rounded) + ", the rolling-ball blend holds " + number(ball_volume) + " inside the balls)";
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

std::unique_ptr<Shape> build_setback_pass(const Shape &source, rust::Slice<const double> edge_raw, rust::Slice<const double> corner_raw, const Mode &mode,
                                          bool &fill_failed, std::string &corners_json, std::string &why, bool allow_star, bool &star_used) {
  fill_failed = false;
  std::map<int, Taper> radius;
  std::vector<Corner> corners;
  if (!parse(edge_raw, corner_raw, mode.automatic, radius, corners, why)) return nullptr;
  const TopoDS_Shape &shape = source.shape;
  if (!mode.automatic) {
    const int kind = step_kind(shape, radius, corners, kVertexFraction * std::max(blend::vertex_diagonal_of(shape), 1e-9));
    if (kind == 2) {
      why = std::string(kUnsupported) +
            "the corners of this step mix vertices on straight edges between planar faces (the setback is measured along the edge) with vertices on a curved edge or face (it is the radius of a ball around the vertex): put them in separate steps";
      return nullptr;
    }
    if (kind == 1) return build_trimmed(source, radius, corners, fill_failed, corners_json, why, allow_star, star_used);
  }
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

  const double volume_tools = volume_of(current.shape);
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
      // a reflex face (13.18.2): the chord would run outside it, the boundary of the hole is P_a -> Q -> P_b along the two contact lines
      const BRepAdaptor_Surface plane(TopoDS::Face(it.Value()), Standard_True);
      const Plan::Reflex *through = nullptr;
      int hits = 0;
      if (plane.GetType() == GeomAbs_Plane)
        for (const Plan::Reflex &candidate : plan.reflex[c])
          if (std::fabs(normal_of(TopoDS::Face(it.Value())).Dot(candidate.normal)) > 1 - 1e-9 &&
              std::fabs(normal_of(TopoDS::Face(it.Value())).Dot(gp_Vec(plane.Plane().Location(), candidate.q))) < 1e-6 * std::max(diagonal, 1.0)) {
            through = &candidate;
            ++hits;
          }
      if (hits > 1) {
        why = std::string(kFailed) + "two reflex faces at " + where(corners[c].at) + " lie in one plane: the cut face cannot be told from its record";
        return nullptr;
      }
      if (through != nullptr) {
        BRepBuilderAPI_MakeVertex corner_vertex(through->q);
        BRepBuilderAPI_MakeEdge first(on_face[0], TopoDS::Vertex(corner_vertex.Shape())), second(TopoDS::Vertex(corner_vertex.Shape()), on_face[1]);
        if (!first.IsDone() || !second.IsDone()) {
          why = std::string(kFailed) + "the path across a reflex face at " + where(corners[c].at) + " could not be made";
          return nullptr;
        }
        chords.Append(first.Edge());
        chords.Append(second.Edge());
        continue;
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
  std::vector<size_t> patch_corner;  // the corner of each patch
  std::vector<std::string> patch_kinds(corners.size());  // "exact" (a star) or "plate" per corner
  std::vector<std::string> patch_names;
  // Serial: isolate the hole of every corner and give its fill its own copies of the support faces (13.20); parallel: the fills; serial, in corner order: the checks and the patches.
  std::vector<FillJob> jobs(corners.size());
  for (size_t c = 0; c < corners.size(); ++c) {
    FillJob &job = jobs[c];
    job.corner = c;
    job.mixed = plan.mixed[c];
    TopTools_IndexedMapOfShape removed;
    const TopoDS_Vertex apex = vertex_at(split, corners[c].at, vertex_tolerance);
    if (apex.IsNull()) {
      job.hole_error = std::string(kFailed) + "the vertex " + where(corners[c].at) + " is gone after the split";
      continue;
    }
    for (TopTools_ListIteratorOfListOfShape it(split_vertex_faces.FindFromKey(apex)); it.More(); it.Next()) removed.Add(it.Value());
    for (const Wall &wall : walls[c]) {
      const TopoDS_Face face = wall_in(split, wall, vertex_tolerance);
      if (!face.IsNull()) removed.Add(face);
    }
    for (int f = 1; f <= removed.Extent(); ++f) job.removed.push_back(removed(f));
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
    const size_t expected = 2 * plan.stubs[c].size() + plan.reflex[c].size();
    const std::vector<TopoDS_Edge> loop = boundary.size() == expected ? loop_of(boundary) : std::vector<TopoDS_Edge>();
    if (loop.size() != expected) {
      job.hole_error = std::string(kFailed) + "the hole at " + where(corners[c].at) + " is bounded by " + std::to_string(boundary.size()) +
                       " edge(s) that do not close one loop (" + std::to_string(expected) + " expected)";
      continue;
    }
    // Both tolerances follow the corner: the 3D one is the sewing tolerance but never more than 1e-4 x the smallest setback, the
    // parametric one a fraction of the setback (a fixed value made the fill of a large part slow and a small corner on a large part coarse).
    double smallest = 1e300;
    for (const auto &entry : corners[c].setbacks) smallest = std::min(smallest, entry.second);
    job.tolerance_3d = std::min(sewing_tolerance, kFillSetbackFraction * smallest);
    job.tolerance_2d = 1e-5 * smallest / 2;
    // The copies: the support faces (which carry the boundary edges) in one compound, copied with their geometry; the loop and the boundary are looked up in the copy.
    BRep_Builder builder;
    TopoDS_Compound shared;
    builder.MakeCompound(shared);
    TopTools_IndexedMapOfShape distinct_supports;
    for (const TopoDS_Face &support : supports)
      if (distinct_supports.Add(support)) builder.Add(shared, support);
    BRepBuilderAPI_Copy copy(shared, Standard_True, Standard_False);
    // ModifiedShape gives the orientation of the first occurrence of the shape in the copy: the orientation looked up is restored.
    const auto image = [&copy](const TopoDS_Shape &original) {
      TopoDS_Shape found = copy.ModifiedShape(original);
      found.Orientation(original.Orientation());
      return found;
    };
    for (const TopoDS_Edge &edge : boundary) job.boundary.push_back(TopoDS::Edge(image(edge)));
    for (const TopoDS_Face &support : supports) job.supports.push_back(TopoDS::Face(image(support)));
    for (const TopoDS_Edge &edge : loop) {
      job.loop.push_back(TopoDS::Edge(image(edge)));
      const size_t at = static_cast<size_t>(std::find_if(boundary.begin(), boundary.end(), [&](const TopoDS_Edge &e) { return e.IsSame(edge); }) - boundary.begin());
      const int support_index = split_faces.FindIndex(supports[at]);
      job.loop_keys.push_back(loop_key(edge, support_index > 0 && static_cast<size_t>(support_index) <= split_names.size() ? split_names[static_cast<size_t>(support_index - 1)] : std::string(),
                                       std::max(1e-6 * diagonal, 1e-12)));
    }
    job.allow_star = allow_star;
  }
  fill_all(jobs, patch_gap_limit, diagonal);
  for (const FillJob &job : jobs) star_used = star_used || !job.patch_loop.empty();
  // test hooks: 3 = a step with a star fails after the fills (the plate pass must then build it), 4 = every step fails there (the message names both reasons)
  if ((g_exact_mode.load() == 3 && star_used) || g_exact_mode.load() == 4) {
    fill_failed = true;
    why = std::string(kFailed) + "forced by the test hook after the fills";
    return nullptr;
  }
  for (size_t c = 0; c < corners.size(); ++c) {
    FillJob &job = jobs[c];
    if (!job.hole_error.empty()) {
      why = job.hole_error;
      return nullptr;
    }
    if (job.error) std::rethrow_exception(job.error);
    if (!job.filled) {
      fill_failed = true;
      why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " " + job.problem;
      return nullptr;
    }
    worst_patch_gap = std::max(worst_patch_gap, job.gap);
    {
      // A convex corner removes material, a concave one adds it: the centre of the patch lies IN the source solid for the first, OUT of it for the second.
      GProp_GProps props;
      if (!job.has_centre) BRepGProp::SurfaceProperties(job.patches.front(), props);
      BRepClass3d_SolidClassifier classifier(shape);
      classifier.Perform(job.has_centre ? job.centre : props.CentreOfMass(), std::max(blend::kInsideTolerance, 1e-9 * diagonal));
      const TopAbs_State expected = plan.concave[c] ? TopAbs_OUT : TopAbs_IN;
      if (!plan.mixed[c] && classifier.State() != expected) {
        // deliberately not fill_failed: a patch on the wrong side is a logic failure of the construction, a finer fit would not change it
        why = std::string(kFailed) + "the corner patch at " + where(corners[c].at) + " lies " + (plan.concave[c] ? "inside" : "outside") +
              " the source solid, on the wrong side of a " + (plan.concave[c] ? "concave" : "convex") + " corner";
        return nullptr;
      }
    }
    std::vector<std::string> around;
    for (const int edge : edges_at(vertex_edges, edge_map, plan.vertices[c])) around.push_back(edge_names[static_cast<size_t>(edge)]);
    // A star's sub-patches are told apart by #k, k = 1.. the rank of the support / position key of the loop edge each has as its bottom (stable under a different start of the loop).
    std::vector<size_t> rank(job.patch_loop.size());
    {
      std::vector<size_t> order(job.patch_loop.size());
      for (size_t k = 0; k < order.size(); ++k) order[k] = k;
      const auto key_of = [&](size_t k) { return std::make_pair(job.loop_keys[job.patch_loop[k]], job.patch_part[k]); };
      std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return key_of(a) < key_of(b); });
      for (size_t k = 0; k < order.size(); ++k) rank[order[k]] = k;
    }
    for (size_t k = 0; k < job.patches.size(); ++k) {
      patches.push_back(job.patches[k]);
      patch_corner.push_back(c);
      patch_names.push_back("blend(v:" + joined_names(around) + ")" + (job.patch_loop.empty() ? std::string() : "#" + std::to_string(rank[k] + 1)));
    }
    patch_kinds[c] = job.patch_loop.empty() ? "plate" : "exact";
    for (const TopoDS_Shape &face : job.removed) dropped.Add(face);
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
  // the direction of the change is only defined for a step whose corners are all of one kind (a mixed corner has material on both sides): the bound below covers every step
  const bool any_mixed = std::count(plan.mixed.begin(), plan.mixed.end(), true) != 0;
  const bool moved_wrongly = !any_mixed && (concave_corners == 0 ? !(volume_after < volume_before) : (concave_corners == plan.concave.size() ? !(volume_after > volume_before) : false));
  if (!(volume_after > 0) || moved_wrongly) {
    fill_failed = true;
    why = std::string(kFailed) + "the corner patches left a solid of volume " + number(volume_after) + " (source " + number(volume_before) + ")";
    return nullptr;
  }
  // Whatever the mix, a patch is far from its corner if it changes the volume by more than the sharp stub material it replaces. At each corner that is bounded by one slab per edge (its setback
  // long, a leg wide in both directions: setback x leg^2, the leg taken AT the corner end) plus the cube of the largest leg where the slabs meet. The volume after the tools (the prisms
  // exactly) moves by less than the sum over the corners. This catches a patch far outside its corner; a patch folded onto its neighbours is caught by the oriented check below.
  double bound = 0;
  for (size_t c = 0; c < corners.size(); ++c) {
    double largest = 0;
    for (const auto &entry : corners[c].setbacks) {
      const EdgeFrame &frame = plan.frames.at(entry.first);
      const double leg = plan.leg_at(entry.first, same_point(frame.start, corners[c].at, plan.tolerance) ? 0.0 : frame.length);
      bound += entry.second * leg * leg;
      largest = std::max(largest, leg);
    }
    bound += largest * largest * largest;
  }
  if (std::fabs(volume_after - volume_tools) > bound) {
    why = std::string(kFailed) + "the corner patches changed the volume by " + number(volume_after - volume_tools) + " where the stubs they replace bound it at " + number(bound) +
          ": a patch far outside its corner";
    return nullptr;
  }
  // The oriented G1 check of every patch of a mixed corner, on the sewn solid (outward normals, both faces' orientation applied).
  {
    TopTools_IndexedDataMapOfShapeListOfShape solid_edge_faces;
    TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, solid_edge_faces);
    for (size_t p = 0; p < patches.size(); ++p) {
      if (!plan.mixed[patch_corner[p]]) continue;
      double worst = 0;
      if (!oriented_patch_angle(TopoDS::Face(sewing.IsModified(patches[p]) ? sewing.Modified(patches[p]) : patches[p]), solid_edge_faces, worst)) {
        // a shortfall of tangency is what another fit setting (or setback factor) can cure; a patch that faces the other way is a logic failure of the construction
        fill_failed = worst < kPi / 2;
        why = std::string(kFailed) + "the corner patch at " + where(corners[patch_corner[p]].at) + " is not tangent to its neighbours across its boundary in the sewn solid (outward normals differ by " +
              number(worst) + " rad, limit " + number(kMixedFillAngle) + (worst > kPi / 2 ? ": it faces the other way" : "") + ")";
        return nullptr;
      }
    }
  }
  const TopTools_IndexedMapOfShape final_faces = query::distinct(solid, TopAbs_FACE);
  std::vector<std::string> names(static_cast<size_t>(final_faces.Extent()));
  for (size_t m = 0; m < members.size(); ++m) {
    const TopoDS_Shape image = sewing.IsModified(members[m]) ? sewing.Modified(members[m]) : members[m];
    const int index = final_faces.FindIndex(image);
    if (index > 0) names[static_cast<size_t>(index - 1)] = member_names[m];
  }
  {
    // the same log with the kind of patch each corner got
    JsonWriter log;
    log.begin_array();
    for (size_t c = 0; c < corners.size(); ++c) {
      log.begin_object().key("vertex").point(corners[c].at).key("patch").string(patch_kinds[c]).key("setbacks").begin_array();
      for (const auto &[edge, distance] : corners[c].setbacks) log.begin_object().key("edge").integer(edge).key("distance").number(distance).end_object();
      log.end_array().end_object();
    }
    corners_json = log.end_array().text();
  }
  return naming::wrap_named(solid, names);
}

// The step is built with the exact stars first; if a star passed its own checks but the step fails after the sewing (free edges, validity, volume, the oriented check) it is built once more
// with the plate patches only, and if that also fails the reason of the star is appended to the plate's.
std::unique_ptr<Shape> build_setback(const Shape &source, rust::Slice<const double> edge_raw, rust::Slice<const double> corner_raw, const Mode &mode,
                                     bool &fill_failed, std::string &corners_json, std::string &why) {
  bool star_used = false;
  std::unique_ptr<Shape> built = build_setback_pass(source, edge_raw, corner_raw, mode, fill_failed, corners_json, why, true, star_used);
  if (built != nullptr || !star_used) return built;
  const std::string star_why = why;
  bool unused = false;
  why.clear();
  built = build_setback_pass(source, edge_raw, corner_raw, mode, fill_failed, corners_json, why, false, unused);
  if (built == nullptr) why += " (the exact-boundary patch was refused: " + star_why + ")";
  return built;
}

}  // namespace

// Test hook (src/test_bridge.rs): the number of threads the corner fills use (0: LLULL_CORNER_THREADS, else the hardware).
void set_corner_threads(int32_t count) { g_corner_threads.store(count); }
// Test hooks: the threads the last fill used, the corner whose fill throws std::bad_alloc (-1: none), the worker whose creation fails (-1: none).
int32_t last_corner_threads() { return g_last_threads.load(); }
void set_corner_fault(int32_t corner) { g_fault_corner.store(corner); }
void set_corner_spawn_limit(int32_t workers) { g_spawn_limit.store(workers); }
void set_corner_exact_patch(int32_t mode) { g_exact_mode.store(mode); }
void set_corner_trim(bool on) { g_force_trim.store(on); }

// Test seams (src/test_bridge.rs, never called by the build): the guards of the mixed corner on a shape the test chooses.
// The oriented check on face `face` of the first solid of `shape`, rebuilt into a shell with that face reversed when `reverse`, over the tangent edges only: about 0 for a blend face as built,
// about pi when it is turned round.
double oriented_angle_probe(const Shape &shape, int32_t face, bool reverse) {
  const TopTools_IndexedMapOfShape faces = query::distinct(shape.shape, TopAbs_FACE);
  if (face < 0 || face >= faces.Extent()) return -1.0;
  BRep_Builder builder;
  TopoDS_Shell rebuilt;
  builder.MakeShell(rebuilt);
  TopoDS_Face picked;
  for (int f = 1; f <= faces.Extent(); ++f) {
    TopoDS_Shape item = faces(f);
    if (f - 1 == face) {
      if (reverse) item = item.Reversed();
      picked = TopoDS::Face(item);
    }
    builder.Add(rebuilt, item);
  }
  TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
  TopExp::MapShapesAndAncestors(rebuilt, TopAbs_EDGE, TopAbs_FACE, edge_faces);
  double worst = 0;
  oriented_patch_angle(picked, edge_faces, worst, true);
  return worst;
}

// boundary_angle on face `face` of `shape` against its neighbours, the loop being all its edges; with `drop_one` the first loop edge is missing from `boundary`. -1 when it is not measured.
double boundary_angle_probe(const Shape &shape, int32_t face, bool drop_one) {
  const TopTools_IndexedMapOfShape faces = query::distinct(shape.shape, TopAbs_FACE);
  if (face < 0 || face >= faces.Extent()) return -1.0;
  const TopoDS_Face patch = TopoDS::Face(faces(face + 1));
  TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
  TopExp::MapShapesAndAncestors(shape.shape, TopAbs_EDGE, TopAbs_FACE, edge_faces);
  std::vector<TopoDS_Edge> loop, boundary;
  std::vector<TopoDS_Face> supports;
  for (TopExp_Explorer it(patch, TopAbs_EDGE); it.More(); it.Next()) {
    const TopoDS_Edge edge = TopoDS::Edge(it.Current());
    for (TopTools_ListIteratorOfListOfShape owner(edge_faces.FindFromKey(edge)); owner.More(); owner.Next())
      if (!owner.Value().IsSame(patch)) {
        loop.push_back(edge);
        if (!(drop_one && loop.size() == 1)) {
          boundary.push_back(edge);
          supports.push_back(TopoDS::Face(owner.Value()));
        }
        break;
      }
  }
  double worst = 0;
  return boundary_angle(patch, loop, boundary, supports, 1e-6, worst) ? worst : -1.0;
}

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

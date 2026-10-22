// Blend support (BLD M0, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.8): the law loader and the failure report of a fillet build.
#include "llull-kernel-occt/cpp/blends.hxx"

#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <BRepCheck_Analyzer.hxx>
#include <BRep_Tool.hxx>
#include <ChFiDS_ErrorStatus.hxx>
#include <Standard_Failure.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>

#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

bool add_fillet_laws(BRepFilletAPI_MakeFillet &maker, const TopTools_IndexedMapOfShape &unique, rust::Slice<const uint32_t> edges,
                     rust::Slice<const double> laws, bool lenient) {
  size_t offset = 0;
  for (uint32_t index : edges) {
    if (static_cast<int>(index) >= unique.Extent() || offset + 3 > laws.size()) return false;
    const double start = laws[offset];
    const double end = laws[offset + 1];
    const size_t count = static_cast<size_t>(laws[offset + 2]);
    if (offset + 3 + 2 * count > laws.size()) return false;
    const TopoDS_Edge edge = TopoDS::Edge(unique(static_cast<int>(index) + 1));
    try {
    if (count == 0 && std::isnan(end)) {
      maker.Add(start, edge);
    } else if (count == 0) {
      maker.Add(start, end, edge);
    } else {
      // Evolving radius: (relative parameter, radius) from the start through the control points to the end.
      TColgp_Array1OfPnt2d law(1, static_cast<int>(count) + 2);
      law.SetValue(1, gp_Pnt2d(0, start));
      for (size_t k = 0; k < count; ++k)
        law.SetValue(static_cast<int>(k) + 2, gp_Pnt2d(laws[offset + 3 + 2 * k], laws[offset + 4 + 2 * k]));
      law.SetValue(static_cast<int>(count) + 2, gp_Pnt2d(1, std::isnan(end) ? start : end));
      maker.Add(law, edge);
    }
    } catch (const Standard_Failure &) {
      if (!lenient) throw;
    }
    offset += 3 + 2 * count;
  }
  return true;
}

namespace {

const char *status_name(ChFiDS_ErrorStatus status) {
  switch (status) {
    case ChFiDS_Ok:
      return "ok";
    case ChFiDS_WalkingFailure:
      return "walking_failure";
    case ChFiDS_StartsolFailure:
      return "startsol_failure";
    case ChFiDS_TwistedSurface:
      return "twisted_surface";
    default:
      return "error";
  }
}

// Distinct non-degenerate edges of the shape meeting at `vertex`, as unique-edge indices.
std::vector<int> incident_edges(const TopTools_IndexedDataMapOfShapeListOfShape &ancestors, const TopTools_IndexedMapOfShape &unique,
                                const TopoDS_Shape &vertex) {
  std::set<int> found;
  if (ancestors.Contains(vertex))
    for (TopTools_ListIteratorOfListOfShape it(ancestors.FindFromKey(vertex)); it.More(); it.Next()) {
      if (BRep_Tool::Degenerated(TopoDS::Edge(it.Value()))) continue;
      const int index = unique.FindIndex(it.Value()) - 1;
      if (index >= 0) found.insert(index);
    }
  return {found.begin(), found.end()};
}

void write_edges(JsonWriter &out, const std::vector<int> &edges) {
  out.begin_array();
  for (int edge : edges) out.integer(edge);
  out.end_array();
}

}  // namespace

rust::String fillet_report_json(const Shape &shape, rust::Slice<const uint32_t> edges, rust::Slice<const double> laws) {
  const TopTools_IndexedMapOfShape unique = query::distinct(shape.shape, TopAbs_EDGE);
  TopTools_IndexedDataMapOfShapeListOfShape ancestors;
  TopExp::MapShapesAndAncestors(shape.shape, TopAbs_VERTEX, TopAbs_EDGE, ancestors);
  std::vector<uint32_t> selected(edges.begin(), edges.end());
  const bool all_edges = selected.empty();
  if (all_edges)
    for (int i = 0; i < unique.Extent(); ++i) selected.push_back(static_cast<uint32_t>(i));
  BRepFilletAPI_MakeFillet maker(shape.shape, ChFi3d_Rational);
  std::string failure;
  if (all_edges) {
    // One law for every edge (laws[0..3)); a degenerate or seam edge is skipped like fillet_edges does.
    for (uint32_t index : selected) {
      try {
        const uint32_t one[1] = {index};
        add_fillet_laws(maker, unique, rust::Slice<const uint32_t>(one, 1), laws, true);
      } catch (const Standard_Failure &) {
      }
    }
  } else if (!add_fillet_laws(maker, unique, edges, laws, true)) {
    failure = "edge index or radius law out of range";
  }
  // Vertices that end a contour on 4 or more edges: OCCT documents them as not handled (checked before Build).
  std::set<int> selected_set(selected.begin(), selected.end());
  std::map<int, std::pair<TopoDS_Vertex, int>> crowded;
  for (uint32_t index : selected) {
    if (static_cast<int>(index) >= unique.Extent()) continue;
    const TopoDS_Edge edge = TopoDS::Edge(unique(static_cast<int>(index) + 1));
    const TopoDS_Vertex ends[2] = {TopExp::FirstVertex(edge), TopExp::LastVertex(edge)};
    for (const TopoDS_Vertex &end : ends) {
      const std::vector<int> around = incident_edges(ancestors, unique, end);
      if (around.size() < 4) continue;
      int hits = 0;
      for (int e : around) hits += selected_set.count(e) ? 1 : 0;
      crowded[ancestors.FindIndex(end)] = {end, hits};
    }
  }
  bool built = false;
  bool done = false;
  if (failure.empty()) {
    try {
      maker.Build();
      built = true;
      done = maker.IsDone();
    } catch (const Standard_Failure &error) {
      failure = error.GetMessageString() != nullptr ? error.GetMessageString() : "Standard_Failure";
    }
  }
  bool valid = false;
  if (done) {
    try {
      valid = BRepCheck_Analyzer(maker.Shape(), Standard_True).IsValid();
    } catch (const Standard_Failure &) {
    }
  }
  JsonWriter out;
  bool contour_failed = false;
  out.begin_object().key("contours").begin_array();
  if (built) {
    for (int c = 1; c <= maker.NbContours(); ++c) {
      ChFiDS_ErrorStatus status = ChFiDS_Ok;
      try {
        status = maker.StripeStatus(c);
      } catch (const Standard_Failure &) {
        status = ChFiDS_Error;
      }
      contour_failed = contour_failed || status != ChFiDS_Ok;
      std::vector<int> members;
      for (int k = 1; k <= maker.NbEdges(c); ++k) members.push_back(unique.FindIndex(maker.Edge(c, k)) - 1);
      out.begin_object().key("edges");
      write_edges(out, members);
      out.key("status").string(status_name(status)).end_object();
    }
  }
  out.end_array().key("vertices").begin_array();
  int faulty_vertices = 0;
  if (built) {
    try {
      faulty_vertices = maker.NbFaultyVertices();
      for (int v = 1; v <= faulty_vertices; ++v) {
        const TopoDS_Vertex vertex = maker.FaultyVertex(v);
        out.begin_object().key("point").point(BRep_Tool::Pnt(vertex)).key("edges");
        write_edges(out, incident_edges(ancestors, unique, vertex));
        out.end_object();
      }
    } catch (const Standard_Failure &) {
    }
  }
  out.end_array().key("unsupportedVertices").begin_array();
  for (const auto &entry : crowded) {
    const TopoDS_Vertex &vertex = entry.second.first;
    out.begin_object().key("point").point(BRep_Tool::Pnt(vertex));
    out.key("edgeCount").integer(static_cast<long long>(incident_edges(ancestors, unique, vertex).size()));
    out.key("selectedEdgeCount").integer(entry.second.second).end_object();
  }
  const char *stage = "none";
  if (!failure.empty() || contour_failed)
    stage = "contours";
  else if (faulty_vertices > 0 || !done)
    stage = "corners";
  else if (!valid)
    stage = "validity";
  out.end_array().key("stage").string(stage);
  out.key("done").boolean(done).key("valid").boolean(valid);
  bool partial = false;
  if (built && !done) {
    try {
      partial = maker.HasResult();
    } catch (const Standard_Failure &) {
    }
  }
  out.key("partial").boolean(partial);
  if (!failure.empty()) out.key("message").string(failure);
  out.end_object();
  return rust::String(out.text());
}

}  // namespace llull

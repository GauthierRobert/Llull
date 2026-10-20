// Import healing shared by the STEP (exchange.cxx, xde_read.cxx) and IGES (iges.cxx) readers: candidate solids, sewing of loose shells, ShapeFix and
// the per-solid report JSON of `importShapes` (occtImport.ts importStepShapes, TR-KRN-20..24).
#pragma once

#include <algorithm>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeExtend_Status.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_FormatVersion.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>

#include "llull-kernel-occt/cpp/query_support.hxx"
#include "rust/cxx.h"

namespace llull {
namespace import {

using query::distinct;


// BRepTools text in the legacy V1 format ('occt-brep-v1' blobs), which every OCCT reader accepts.
inline std::string brep_text(const TopoDS_Shape &shape) {
  std::ostringstream stream;
  BRepTools::Write(shape, stream, Standard_False, Standard_False, TopTools_FormatVersion_VERSION_1);
  return stream.str();
}

inline bool is_valid(const TopoDS_Shape &shape) { return BRepCheck_Analyzer(shape, Standard_True).IsValid(); }

inline int count_of(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) { return distinct(shape, kind).Extent(); }

inline double max_tolerance_of(const TopoDS_Shape &shape) {
  double max = 0;
  const auto vertices = distinct(shape, TopAbs_VERTEX);
  for (int i = 1; i <= vertices.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Vertex(vertices(i))));
  const auto edges = distinct(shape, TopAbs_EDGE);
  for (int i = 1; i <= edges.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Edge(edges(i))));
  const auto faces = distinct(shape, TopAbs_FACE);
  for (int i = 1; i <= faces.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Face(faces(i))));
  return max;
}

inline int free_edge_count(const TopoDS_Shape &shape, double tolerance) {
  try {
    ShapeAnalysis_FreeBounds bounds(shape, tolerance, Standard_False, Standard_False);
    return count_of(bounds.GetClosedWires(), TopAbs_EDGE) + count_of(bounds.GetOpenWires(), TopAbs_EDGE);
  } catch (const Standard_Failure &) {
    return 0;
  }
}

// AP242 tessellated geometry (TRIANGULATED_FACE, COMPLEX_TRIANGULATED_FACE, read by OCCT >= 7.6) becomes faces holding a
// Poly_Triangulation and no surface: not an exact B-rep, so such a solid or shell is skipped (the retired 7.4 reader never transferred it).
inline bool is_tessellated(const TopoDS_Shape &shape) {
  const auto faces = distinct(shape, TopAbs_FACE);
  for (int i = 1; i <= faces.Extent(); ++i) {
    TopLoc_Location location;
    if (BRep_Tool::Surface(TopoDS::Face(faces(i)), location).IsNull()) return true;
  }
  return false;
}

inline bool is_faceted(const TopoDS_Shape &shape) {
  const auto faces = distinct(shape, TopAbs_FACE);
  if (faces.Extent() == 0) return false;
  for (int i = 1; i <= faces.Extent(); ++i) {
    const BRepAdaptor_Surface adaptor(TopoDS::Face(faces(i)), Standard_True);
    if (adaptor.GetType() != GeomAbs_Plane || count_of(faces(i), TopAbs_EDGE) != 3) return false;
  }
  return true;
}

struct Candidate {
  TopoDS_Shape shape;
  bool valid_as_read;
  bool sewn;
};

struct Options {
  double precision;
  double max_tolerance;
  bool heal;
  bool sew;
};

inline std::string format_number(double value) {
  JsonWriter writer;
  writer.number(value);
  return writer.text();
}

inline std::vector<Candidate> sew_loose(const std::vector<TopoDS_Shape> &loose, double precision, std::vector<std::string> &skipped) {
  BRepBuilderAPI_Sewing sewing(precision * 10, Standard_True, Standard_True, Standard_True, Standard_False);
  for (const TopoDS_Shape &piece : loose) sewing.Add(piece);
  sewing.Perform();
  const TopoDS_Shape sewn = sewing.SewedShape();
  std::vector<Candidate> found;
  if (sewn.IsNull()) return found;
  const auto shells = distinct(sewn, TopAbs_SHELL);
  for (int i = 1; i <= shells.Extent(); ++i) {
    const TopoDS_Shell shell = TopoDS::Shell(shells(i));
    if (BRep_Tool::IsClosed(shell)) {
      found.push_back({ShapeFix_Solid().SolidFromShell(shell), false, true});
    } else {
      skipped.push_back("open shell with " + std::to_string(free_edge_count(shell, precision)) + " free edges after sewing at " +
                        format_number(precision * 10) + " mm");
    }
  }
  return found;
}

inline void write_report(JsonWriter &out, const Candidate &candidate, const Options &options) {
  const double tolerance_before = max_tolerance_of(candidate.shape);
  TopoDS_Shape fixed = candidate.shape;
  std::vector<std::string> actions;
  if (candidate.sewn) actions.push_back("sewn");
  if (options.heal) {
    ShapeFix_Shape fixer(candidate.shape);
    fixer.SetPrecision(options.precision);
    fixer.SetMaxTolerance(options.max_tolerance);
    fixer.SetMinTolerance(options.precision / 10);
    fixer.Perform();
    if (fixer.Status(ShapeExtend_DONE)) actions.push_back("shape_fix");
    fixed = fixer.Shape();
  }
  const auto solids = distinct(fixed, TopAbs_SOLID);
  const TopoDS_Shape final_shape = solids.Extent() == 1 ? solids(1) : fixed;
  const double max_tolerance = max_tolerance_of(final_shape);
  if (max_tolerance > tolerance_before * (1 + 1e-9)) actions.push_back("tolerance_grown");
  out.begin_object().key("brep").string(brep_text(final_shape)).key("validAsRead").boolean(candidate.valid_as_read);
  out.key("validAfterHeal").boolean(is_valid(final_shape)).key("actions").begin_array();
  for (const std::string &action : actions) out.string(action);
  out.end_array().key("maxToleranceMm").number(max_tolerance).key("freeEdges").integer(free_edge_count(final_shape, options.precision));
  out.key("faces").integer(count_of(final_shape, TopAbs_FACE)).key("faceted").boolean(is_faceted(final_shape)).end_object();
}

// Sub-shapes of `kind` outside any `avoid` ancestor (free shells outside solids, loose faces outside shells); explorer order, not deduplicated.
inline std::vector<TopoDS_Shape> outside(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind, TopAbs_ShapeEnum avoid) {
  std::vector<TopoDS_Shape> found;
  for (TopExp_Explorer explorer(shape, kind, avoid); explorer.More(); explorer.Next()) found.push_back(explorer.Current());
  return found;
}

inline rust::String error_json(const char *code, const std::string &detail) {
  JsonWriter out;
  out.begin_object().key("error").string(code).key("detail").string(detail).end_object();
  return rust::String(out.text());
}

}  // namespace import
}  // namespace llull

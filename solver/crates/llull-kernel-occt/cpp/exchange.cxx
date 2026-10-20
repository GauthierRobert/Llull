// Exchange half of the native query facade: STEP assemblies (occtStep.ts writeStepAssembly), B-rep blobs (occtImport.ts readBrepText /
// brepText) and STEP import + healing (occtImport.ts importStepShapes, TR-KRN-20..24), following the retired opencascade.js kernel step for step so
// both report the same census, solids, faces and healing actions.
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_Writer.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeExtend_Status.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_FormatVersion.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <gp_Ax1.hxx>
#include <gp_Trsf.hxx>

#include "llull-kernel-occt/cpp/queries.hxx"
#include "llull-kernel-occt/cpp/query_support.hxx"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

using query::distinct;

namespace {

// llull placement M = T · Rx · Ry · Rz (occtShapes.ts placementTransform; same as facade.cxx `placement` without an anchor).
gp_Trsf placement(rust::Slice<const double> rotation, rust::Slice<const double> position) {
  if (rotation.size() != 3 || position.size() != 3) throw std::invalid_argument("placement: need 3 rotation and 3 position components");
  gp_Trsf total;
  total.SetTranslation(gp_Vec(position[0], position[1], position[2]));
  const double axes[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (int k = 0; k < 3; ++k) {
    gp_Trsf turn;
    turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(axes[k][0], axes[k][1], axes[k][2])), rotation[k]);
    total.Multiply(turn);
  }
  return total;
}

TopoDS_Compound &part_of(StepAssembly &assembly, int32_t part) {
  if (part < 0 || static_cast<size_t>(part) >= assembly.parts.size()) throw std::invalid_argument("assembly: unknown part");
  return assembly.parts[static_cast<size_t>(part)];
}

}  // namespace

std::unique_ptr<StepAssembly> new_step_assembly() { return std::make_unique<StepAssembly>(); }

int32_t assembly_part(StepAssembly &assembly) {
  TopoDS_Compound part;
  BRep_Builder().MakeCompound(part);
  assembly.parts.push_back(part);
  return static_cast<int32_t>(assembly.parts.size() - 1);
}

void assembly_add_shape(StepAssembly &assembly, int32_t part, const Shape &shape) { BRep_Builder().Add(part_of(assembly, part), shape.shape); }

void assembly_add_use(StepAssembly &assembly, int32_t parent, int32_t part, rust::Slice<const double> rotation,
                      rust::Slice<const double> position) {
  // A location composes with the ones inside the part (TopLoc_Location product), so a nested part is written once.
  const TopoDS_Shape moved = part_of(assembly, part).Moved(TopLoc_Location(placement(rotation, position)));
  if (parent >= 0) {
    BRep_Builder().Add(part_of(assembly, parent), moved);
    return;
  }
  if (!assembly.root_made) {
    BRep_Builder().MakeCompound(assembly.root);
    assembly.root_made = true;
  }
  BRep_Builder().Add(assembly.root, moved);
}

rust::String assembly_write(StepAssembly &assembly) {
  if (!assembly.root_made) BRep_Builder().MakeCompound(assembly.root);
  STEPControl_Writer writer;
  if (writer.Transfer(assembly.root, STEPControl_AsIs, Standard_True) != IFSelect_RetDone) return rust::String();
  std::ostringstream text;
  if (writer.WriteStream(text) != IFSelect_RetDone) return rust::String();
  return rust::String(text.str());
}

std::unique_ptr<Shape> read_brep(rust::Str text) {
  std::istringstream stream(std::string(text.data(), text.size()));
  TopoDS_Shape shape;
  BRep_Builder builder;
  BRepTools::Read(shape, stream, builder);
  if (shape.IsNull()) return nullptr;
  return std::make_unique<Shape>(shape);
}

namespace {

// BRepTools text in the legacy V1 format ('occt-brep-v1' blobs), which every OCCT reader accepts.
std::string brep_text(const TopoDS_Shape &shape) {
  std::ostringstream stream;
  BRepTools::Write(shape, stream, Standard_False, Standard_False, TopTools_FormatVersion_VERSION_1);
  return stream.str();
}

bool is_valid(const TopoDS_Shape &shape) { return BRepCheck_Analyzer(shape, Standard_True).IsValid(); }

int count_of(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind) { return distinct(shape, kind).Extent(); }

double max_tolerance_of(const TopoDS_Shape &shape) {
  double max = 0;
  const auto vertices = distinct(shape, TopAbs_VERTEX);
  for (int i = 1; i <= vertices.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Vertex(vertices(i))));
  const auto edges = distinct(shape, TopAbs_EDGE);
  for (int i = 1; i <= edges.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Edge(edges(i))));
  const auto faces = distinct(shape, TopAbs_FACE);
  for (int i = 1; i <= faces.Extent(); ++i) max = std::max(max, BRep_Tool::Tolerance(TopoDS::Face(faces(i))));
  return max;
}

int free_edge_count(const TopoDS_Shape &shape, double tolerance) {
  try {
    ShapeAnalysis_FreeBounds bounds(shape, tolerance, Standard_False, Standard_False);
    return count_of(bounds.GetClosedWires(), TopAbs_EDGE) + count_of(bounds.GetOpenWires(), TopAbs_EDGE);
  } catch (const Standard_Failure &) {
    return 0;
  }
}

// AP242 tessellated geometry (TRIANGULATED_FACE, COMPLEX_TRIANGULATED_FACE, read by OCCT >= 7.6) becomes faces holding a
// Poly_Triangulation and no surface: not an exact B-rep, so such a solid or shell is skipped (the retired 7.4 reader never transferred it).
bool is_tessellated(const TopoDS_Shape &shape) {
  const auto faces = distinct(shape, TopAbs_FACE);
  for (int i = 1; i <= faces.Extent(); ++i) {
    TopLoc_Location location;
    if (BRep_Tool::Surface(TopoDS::Face(faces(i)), location).IsNull()) return true;
  }
  return false;
}

bool is_faceted(const TopoDS_Shape &shape) {
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

std::string format_number(double value) {
  JsonWriter writer;
  writer.number(value);
  return writer.text();
}

std::vector<Candidate> sew_loose(const std::vector<TopoDS_Shape> &loose, double precision, std::vector<std::string> &skipped) {
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

void write_report(JsonWriter &out, const Candidate &candidate, const Options &options) {
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
std::vector<TopoDS_Shape> outside(const TopoDS_Shape &shape, TopAbs_ShapeEnum kind, TopAbs_ShapeEnum avoid) {
  std::vector<TopoDS_Shape> found;
  for (TopExp_Explorer explorer(shape, kind, avoid); explorer.More(); explorer.Next()) found.push_back(explorer.Current());
  return found;
}

rust::String error_json(const char *code, const std::string &detail) {
  JsonWriter out;
  out.begin_object().key("error").string(code).key("detail").string(detail).end_object();
  return rust::String(out.text());
}

}  // namespace

rust::String write_brep(const Shape &shape) { return rust::String(brep_text(shape.shape)); }

rust::String import_step_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew) {
  const std::string content(text.data(), text.size());
  STEPControl_Reader reader;
  std::istringstream stream(content);
  if (reader.ReadStream("in.step", stream) != IFSelect_RetDone)
    return error_json("unreadable", "the file is not a readable ISO 10303-21 STEP file");
  const int roots = reader.NbRootsForTransfer();
  const int transferred = roots > 0 ? reader.TransferRoots() : 0;
  const TopoDS_Shape shape = transferred > 0 && reader.NbShapes() > 0 ? reader.OneShape() : TopoDS_Shape();
  return imported_shapes_json(shape, roots, content, precision, max_tolerance, heal, sew);
}

rust::String imported_shapes_json(const TopoDS_Shape &shape, int roots, const std::string &content, double precision, double max_tolerance,
                                  bool heal, bool sew) {
  const Options options{precision, max_tolerance, heal, sew};
  if (shape.IsNull()) {
    const bool tessellated = content.find("TESSELLATED_") != std::string::npos ||
                             content.find("TRIANGULATED_FACE") != std::string::npos ||
                             content.find("COMPLEX_TRIANGULATED") != std::string::npos;
    if (tessellated)
      return error_json("tessellated_only", "the file holds TESSELLATED_* geometry only; the B-rep reader transferred nothing");
    return error_json("unreadable", std::to_string(roots) + " root entities, none transferred to a shape");
  }
  const auto solids = distinct(shape, TopAbs_SOLID);
  const auto loose_shells = outside(shape, TopAbs_SHELL, TopAbs_SOLID);
  const auto loose_faces = outside(shape, TopAbs_FACE, TopAbs_SHELL);
  int open_shells = 0;
  for (const TopoDS_Shape &shell : loose_shells)
    if (!BRep_Tool::IsClosed(TopoDS::Shell(shell))) ++open_shells;
  const int shells = count_of(shape, TopAbs_SHELL);
  const int faces = count_of(shape, TopAbs_FACE);
  std::vector<std::string> skipped;
  std::vector<Candidate> candidates;
  int tessellated = 0;
  for (int i = 1; i <= solids.Extent(); ++i) {
    if (is_tessellated(solids(i))) {
      ++tessellated;
      continue;
    }
    candidates.push_back({solids(i), is_valid(solids(i)), false});
  }
  std::vector<TopoDS_Shape> loose;
  for (const auto *pieces : {&loose_shells, &loose_faces})
    for (const TopoDS_Shape &piece : *pieces) {
      if (is_tessellated(piece)) {
        ++tessellated;
        continue;
      }
      loose.push_back(piece);
    }
  if (tessellated > 0)
    skipped.push_back(std::to_string(tessellated) + " tessellated pieces (triangulated faces without exact surfaces)");
  if (tessellated > 0 && solids.Extent() + static_cast<int>(loose_shells.size() + loose_faces.size()) == tessellated)
    return error_json("tessellated_only", "the file holds TESSELLATED_* geometry only (" + std::to_string(tessellated) +
                                              " triangulated pieces, no exact B-rep surfaces)");
  if (!loose.empty() && options.sew) {
    for (Candidate &candidate : sew_loose(loose, precision, skipped)) candidates.push_back(candidate);
  } else if (!loose.empty()) {
    skipped.push_back(std::to_string(loose_shells.size()) + " loose shells and " + std::to_string(loose_faces.size()) +
                      " loose faces (sew is off)");
  }
  if (candidates.empty()) {
    std::string detail = std::to_string(solids.Extent()) + " solids, " + std::to_string(shells) + " shells (" +
                         std::to_string(open_shells) + " open), " + std::to_string(faces) + " faces; ";
    for (size_t i = 0; i < skipped.size(); ++i) detail += (i > 0 ? "; " : "") + skipped[i];
    return error_json("no_solid", detail);
  }
  JsonWriter out;
  out.begin_object().key("solids").begin_array();
  for (const Candidate &candidate : candidates) write_report(out, candidate, options);
  out.end_array().key("census").begin_object().key("roots").integer(roots).key("solids").integer(solids.Extent());
  out.key("shells").integer(shells).key("openShells").integer(open_shells).key("faces").integer(faces).end_object();
  out.key("skipped").begin_array();
  for (const std::string &item : skipped) out.string(item);
  out.end_array().end_object();
  return rust::String(out.text());
}

}  // namespace llull

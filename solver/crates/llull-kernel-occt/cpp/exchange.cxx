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

#include "llull-kernel-occt/cpp/import_support.hxx"
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

using namespace import;


rust::String write_brep(const Shape &shape) { return rust::String(brep_text(shape.shape)); }

rust::String import_step_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew) {
  const std::string content(text.data(), text.size());
  const Options options{precision, max_tolerance, heal, sew};
  STEPControl_Reader reader;
  std::istringstream stream(content);
  if (reader.ReadStream("in.step", stream) != IFSelect_RetDone)
    return error_json("unreadable", "the file is not a readable ISO 10303-21 STEP file");
  const int roots = reader.NbRootsForTransfer();
  const int transferred = roots > 0 ? reader.TransferRoots() : 0;
  const TopoDS_Shape shape = transferred > 0 && reader.NbShapes() > 0 ? reader.OneShape() : TopoDS_Shape();
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

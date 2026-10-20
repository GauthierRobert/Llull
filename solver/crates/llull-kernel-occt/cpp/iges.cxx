// IGES (XCH 04 M4, TR-XCH-12/13): IGESControl_Reader + sewing + healing (the `importShapes` report shape), IGESControl_Writer for B-rep or
// faces mode. The translator lives in TKDEIGES, which is linked only when the OCCT prefix holds it (LLULL_HAS_IGES, see build.rs);
// without it `iges_available()` is false and the reader answers `unavailable`. IGES calls are not thread-safe in OCCT: the sidecar is
// single-threaded, so they are serialised by construction.
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "llull-kernel-occt/cpp/import_support.hxx"
#include "llull-kernel-occt/cpp/xde.hxx"

#ifdef LLULL_HAS_IGES
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <Bnd_Box.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <IGESControl_Controller.hxx>
#include <IGESControl_Reader.hxx>
#include <IGESControl_Writer.hxx>
#endif

namespace llull {

using namespace import;

#ifdef LLULL_HAS_IGES

namespace {

double metres_per_unit(const std::string &unit) {
  if (unit == "mm") return 0.001;
  if (unit == "cm") return 0.01;
  if (unit == "m") return 1.0;
  if (unit == "in") return 0.0254;
  if (unit == "ft") return 0.3048;
  throw std::invalid_argument("unknown length unit '" + unit + "'");
}

// A file in the temp directory holding `text`, removed with the object.
class TemporaryFile {
 public:
  explicit TemporaryFile(const std::string &text) {
    static unsigned counter = 0;
    std::error_code error;
    const std::string name = "llull-iges-" + std::to_string(++counter) + "-" + std::to_string(reinterpret_cast<std::uintptr_t>(this)) + ".igs";
    path_ = (std::filesystem::temp_directory_path(error) / name).string();
    std::ofstream out(path_, std::ios::binary);
    out.write(text.data(), static_cast<std::streamsize>(text.size()));
    ok_ = out.good();
  }
  ~TemporaryFile() {
    std::error_code error;
    std::filesystem::remove(path_, error);
  }
  TemporaryFile(const TemporaryFile &) = delete;
  TemporaryFile &operator=(const TemporaryFile &) = delete;
  bool ok() const { return ok_; }
  const std::string &path() const { return path_; }

 private:
  std::string path_;
  bool ok_ = false;
};

const char *iges_unit(const std::string &unit) {
  if (unit == "mm") return "MM";
  if (unit == "cm") return "CM";
  if (unit == "m") return "M";
  if (unit == "in") return "INCH";
  return "FT";
}

}  // namespace

bool iges_available() { return true; }

rust::String iges_import_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew, double file_resolution) {
  const std::string content(text.data(), text.size());
  const Options options{precision, max_tolerance, heal, sew};
  // the IGES reader has no stream entry point: the text goes through a private temporary file
  const TemporaryFile file(content);
  IGESControl_Reader reader;
  if (!file.ok() || reader.ReadFile(file.path().c_str()) != IFSelect_RetDone)
    return error_json("unreadable", "the file is not a readable IGES file");
  const int roots = reader.NbRootsForTransfer();
  const int transferred = roots > 0 ? reader.TransferRoots() : 0;
  const TopoDS_Shape shape = transferred > 0 && reader.NbShapes() > 0 ? reader.OneShape() : TopoDS_Shape();
  if (shape.IsNull()) return error_json("unreadable", std::to_string(roots) + " root entities, none transferred to a shape");
  const auto solids = distinct(shape, TopAbs_SOLID);
  const auto loose_shells = outside(shape, TopAbs_SHELL, TopAbs_SOLID);
  const auto loose_faces = outside(shape, TopAbs_FACE, TopAbs_SHELL);
  int open_shells = 0;
  for (const TopoDS_Shape &shell : loose_shells)
    if (!BRep_Tool::IsClosed(TopoDS::Shell(shell))) ++open_shells;
  const int shells = count_of(shape, TopAbs_SHELL);
  const int faces = count_of(shape, TopAbs_FACE);
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  const double diagonal = box.IsVoid() ? 0.0 : std::sqrt(box.SquareExtent());
  // TR-XCH-12: sewing at max(the file's own resolution, 1e-6 * diagonal), never below the document tolerance.
  const double sewing = std::max({file_resolution, 1e-6 * diagonal, precision});
  std::vector<std::string> skipped;
  std::vector<Candidate> candidates;
  for (int i = 1; i <= solids.Extent(); ++i) candidates.push_back({solids(i), is_valid(solids(i)), false});
  std::vector<TopoDS_Shape> loose(loose_shells.begin(), loose_shells.end());
  loose.insert(loose.end(), loose_faces.begin(), loose_faces.end());
  if (!loose.empty() && sew) {
    for (Candidate &candidate : sew_loose(loose, sewing / 10, skipped)) candidates.push_back(candidate);
  } else if (!loose.empty()) {
    skipped.push_back(std::to_string(loose_shells.size()) + " loose shells and " + std::to_string(loose_faces.size()) +
                      " loose faces (sew is off)");
  }
  if (candidates.empty()) {
    std::string detail = std::to_string(solids.Extent()) + " solids, " + std::to_string(shells) + " shells (" + std::to_string(open_shells) +
                         " open), " + std::to_string(faces) + " faces; ";
    for (size_t i = 0; i < skipped.size(); ++i) detail += (i > 0 ? "; " : "") + skipped[i];
    return error_json("no_solid", detail);
  }
  JsonWriter out;
  out.begin_object().key("solids").begin_array();
  for (const Candidate &candidate : candidates) write_report(out, candidate, options);
  out.end_array().key("census").begin_object().key("roots").integer(roots).key("solids").integer(solids.Extent());
  out.key("shells").integer(shells).key("openShells").integer(open_shells).key("faces").integer(faces).end_object();
  out.key("sewingToleranceMm").number(sewing).key("diagonalMm").number(diagonal);
  out.key("skipped").begin_array();
  for (const std::string &item : skipped) out.string(item);
  out.end_array().end_object();
  return rust::String(out.text());
}

rust::String iges_write(XdeDoc &doc, bool brep_mode, rust::Str unit) {
  const std::string unit_name(unit.data(), unit.size());
  const double to_mm = metres_per_unit(unit_name) * 1000.0;
  IGESControl_Controller::Init();
  IGESControl_Writer writer(iges_unit(unit_name), brep_mode ? 1 : 0);
  int written = 0;
  for (const XdeProduct &product : doc.products)
    for (const XdeSolid &solid : product.solids) {
      // OCCT's model unit is the millimetre: a document in another unit is scaled into mm so the file carries the document's own numbers.
      gp_Trsf scale;
      scale.SetScaleFactor(to_mm);
      const TopoDS_Shape shape = to_mm == 1.0 ? solid.shape : BRepBuilderAPI_Transform(solid.shape, scale, Standard_True).Shape();
      if (writer.AddShape(shape)) ++written;
    }
  if (written == 0) return rust::String();
  writer.ComputeModel();
  std::ostringstream text;
  if (!writer.Write(text)) return rust::String();
  return rust::String(text.str());
}

#else

bool iges_available() { return false; }

rust::String iges_import_json(rust::Str, double, double, bool, bool, double) {
  return error_json("unavailable", "this llull-kernel was built without the OCCT IGES translator (TKDEIGES)");
}

rust::String iges_write(XdeDoc &, bool, rust::Str) { return rust::String(); }

#endif

}  // namespace llull

// IGES exchange of the native kernel (SC-D4): IGES 5.3 export of exact solids (IGESControl_Writer, B-rep mode, millimetres) and import
// (IGESControl_Reader) with the same healing / sewing / report as the STEP importer (exchange.cxx imported_shapes_json).
#include "llull-kernel-occt/cpp/features.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"
#include "llull-kernel-occt/cpp/queries.hxx"

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include <IFSelect_ReturnStatus.hxx>
#include <IGESControl_Controller.hxx>
#include <IGESControl_Reader.hxx>
#include <IGESControl_Writer.hxx>
#include <Interface_Static.hxx>

#include "llull-kernel-occt/src/features.rs.h"
#include "llull-kernel-occt/src/queries.rs.h"

namespace llull {

namespace {

// A file the reader can open, removed when it goes out of scope (IGESControl_Reader reads files, not streams).
class TemporaryFile {
 public:
  explicit TemporaryFile(const std::string &content) {
    static std::atomic<unsigned> counter{0};
    path_ = std::filesystem::temp_directory_path() / ("llull-iges-" + std::to_string(counter++) + "-" +
                                                      std::to_string(reinterpret_cast<std::uintptr_t>(this)) + ".igs");
    std::ofstream out(path_, std::ios::binary);
    out << content;
  }
  ~TemporaryFile() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }
  TemporaryFile(const TemporaryFile &) = delete;
  TemporaryFile &operator=(const TemporaryFile &) = delete;
  std::string path() const { return path_.string(); }

 private:
  std::filesystem::path path_;
};

}  // namespace

rust::String export_iges(const ShapeList &list) {
  IGESControl_Controller::Init();
  // B-rep mode (MSBO / faces with exact surfaces), not the trimmed-surface default, so a reader rebuilds solids.
  IGESControl_Writer writer("MM", 1);
  for (const TopoDS_Shape &shape : list.shapes)
    if (!writer.AddShape(shape)) return rust::String("");
  writer.ComputeModel();
  std::ostringstream text;
  if (!writer.Write(text)) return rust::String("");
  return rust::String(text.str());
}

rust::String import_iges_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew) {
  const std::string content(text.data(), text.size());
  IGESControl_Controller::Init();
  const TemporaryFile file(content);
  IGESControl_Reader reader;
  if (reader.ReadFile(file.path().c_str()) != IFSelect_RetDone) {
    JsonWriter out;
    out.begin_object().key("error").string("unreadable").key("detail").string("the file is not a readable IGES file").end_object();
    return rust::String(out.text());
  }
  const int roots = reader.NbRootsForTransfer();
  const int transferred = roots > 0 ? reader.TransferRoots() : 0;
  const TopoDS_Shape shape = transferred > 0 && reader.NbShapes() > 0 ? reader.OneShape() : TopoDS_Shape();
  return imported_shapes_json(shape, roots, content, precision, max_tolerance, heal, sew);
}

}  // namespace llull

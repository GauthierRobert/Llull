// XDE reader (XCH 04 M3, TR-XCH-08): STEPCAFControl_Reader into an XCAF document, then the product tree as JSON: products (simple shapes
// holding healed solids, or assemblies), the placed occurrences between them, names, colours, layers and the geometric validation properties
// OCCT attached to each product label. Solids are healed exactly like `import_step_json` (import_support.hxx); lengths are millimetres.
#include <stdexcept>
#include <cstdio>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Quantity_Color.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TCollection_AsciiString.hxx>
#include <XSControl_WorkSession.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TColStd_HSequenceOfExtendedString.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_Area.hxx>
#include <XCAFDoc_Centroid.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Volume.hxx>
#include <gp_Trsf.hxx>

#include "llull-kernel-occt/cpp/import_support.hxx"
#include "llull-kernel-occt/cpp/xde.hxx"

namespace llull {

using namespace import;

namespace {

std::string name_of(const TDF_Label &label) {
  Handle(TDataStd_Name) name;
  if (label.IsNull() || !label.FindAttribute(TDataStd_Name::GetID(), name)) return "";
  const TCollection_AsciiString ascii(name->Get(), '?');
  return std::string(ascii.ToCString());
}

std::string hex_of(const Quantity_Color &color) {
  double red = 0, green = 0, blue = 0;
  color.Values(red, green, blue, Quantity_TOC_sRGB);
  char text[8];
  std::snprintf(text, sizeof(text), "#%02x%02x%02x", static_cast<int>(red * 255 + 0.5), static_cast<int>(green * 255 + 0.5),
                static_cast<int>(blue * 255 + 0.5));
  return text;
}

class TreeReader {
 public:
  TreeReader(const Handle(TDocStd_Document) & document, const Options &options)
      : options_(options),
        shapes_(XCAFDoc_DocumentTool::ShapeTool(document->Main())),
        dimtol_(XCAFDoc_DocumentTool::DimTolTool(document->Main())),
        colors_(XCAFDoc_DocumentTool::ColorTool(document->Main())),
        layers_(XCAFDoc_DocumentTool::LayerTool(document->Main())) {}

  const std::string *content_ = nullptr;   // the Part 21 text, for magnitudes OCC cannot type
  Handle(XSControl_WorkSession) session_;  // the STEP side of the reader (null: XCAF only)
  std::vector<int> roots;
  std::vector<std::string> skipped;
  int tessellated = 0;
  int pmi_unmapped = 0;
  int solid_count = 0;
  int shell_count = 0;
  int open_shells = 0;
  int face_count = 0;

  void read() {
    TDF_LabelSequence free_shapes;
    shapes_->GetFreeShapes(free_shapes);
    for (Standard_Integer i = 1; i <= free_shapes.Length(); ++i) roots.push_back(visit(free_shapes.Value(i)));
    std::map<int, TopoDS_Shape> shape_of;
    for (size_t index = 0; index < products_.size(); ++index)
      if (!products_[index].assembly) shape_of[static_cast<int>(index)] = XCAFDoc_ShapeTool::GetShape(labels_[index]);
    for (auto &entry : read_pmi(dimtol_, known_, shape_of, session_, content_ == nullptr ? std::string() : *content_, pmi_unmapped)) products_[static_cast<size_t>(entry.first)].pmi = entry.second;
  }

  rust::String finish(int file_roots) {
    if (solids_.empty()) {
      std::string detail = std::to_string(solid_count) + " solids, " + std::to_string(shell_count) + " shells (" +
                           std::to_string(open_shells) + " open), " + std::to_string(face_count) + " faces; ";
      for (size_t i = 0; i < skipped.size(); ++i) detail += (i > 0 ? "; " : "") + skipped[i];
      if (tessellated > 0 && solid_count + shell_count == tessellated)
        return error_json("tessellated_only", "the file holds TESSELLATED_* geometry only (" + std::to_string(tessellated) +
                                                  " triangulated pieces, no exact B-rep surfaces)");
      return error_json("no_solid", detail);
    }
    JsonWriter out;
    out.begin_object().key("solids").begin_array();
    for (const std::string &solid : solids_) out.raw(solid);
    out.end_array().key("products").begin_array();
    for (const Product &product : products_) write_product(out, product);
    out.end_array().key("occurrences").begin_array();
    for (const Occurrence &use : occurrences_) {
      out.begin_object().key("parent").integer(use.parent).key("product").integer(use.product).key("name").string(use.name);
      out.key("matrix").begin_array();
      for (int row = 1; row <= 3; ++row)
        for (int column = 1; column <= 4; ++column) out.number(use.placement.Value(row, column));
      out.end_array().end_object();
    }
    out.end_array().key("roots").begin_array();
    for (const int root : roots) out.integer(root);
    out.end_array().key("census").begin_object().key("roots").integer(file_roots).key("solids").integer(solid_count);
    out.key("shells").integer(shell_count).key("openShells").integer(open_shells).key("faces").integer(face_count).end_object();
    out.key("pmiUnmapped").integer(pmi_unmapped);
    out.key("skipped").begin_array();
    for (const std::string &item : skipped) out.string(item);
    out.end_array().end_object();
    return rust::String(out.text());
  }

 private:
  struct Product {
    std::string name;
    std::string color;
    std::vector<std::string> layers;
    std::vector<int> solids;
    bool assembly = false;
    bool has_validation = false;
    double volume = 0, area = 0;
    bool has_centroid = false;
    double centroid[3] = {0, 0, 0};
    std::string pmi;  // JSON of the product's semantic PMI (xde_pmi.cxx), empty when none
  };
  struct Occurrence {
    int parent;
    int product;
    std::string name;
    gp_Trsf placement;
  };

  Options options_;
  Handle(XCAFDoc_ShapeTool) shapes_;
  Handle(XCAFDoc_ColorTool) colors_;
  Handle(XCAFDoc_LayerTool) layers_;
  Handle(XCAFDoc_DimTolTool) dimtol_;
  std::vector<TDF_Label> labels_;
  std::map<std::string, int> known_;
  std::vector<Product> products_;
  std::vector<Occurrence> occurrences_;
  std::vector<std::string> solids_;

  static void write_product(JsonWriter &out, const Product &product) {
    out.begin_object().key("name").string(product.name).key("assembly").boolean(product.assembly);
    if (!product.color.empty()) out.key("color").string(product.color);
    out.key("layers").begin_array();
    for (const std::string &layer : product.layers) out.string(layer);
    out.end_array().key("solids").begin_array();
    for (const int solid : product.solids) out.integer(solid);
    out.end_array();
    if (!product.pmi.empty()) out.key("pmi").raw(product.pmi);
    if (product.has_validation) {
      out.key("validation").begin_object().key("volume").number(product.volume).key("area").number(product.area);
      if (product.has_centroid)
        out.key("centroid").begin_array().number(product.centroid[0]).number(product.centroid[1]).number(product.centroid[2]).end_array();
      out.end_object();
    }
    out.end_object();
  }

  std::string colour_of(const TDF_Label &label, const TopoDS_Shape &shape) const {
    Quantity_Color color;
    if (colors_->GetColor(label, XCAFDoc_ColorSurf, color) || colors_->GetColor(label, XCAFDoc_ColorGen, color)) return hex_of(color);
    if (!shape.IsNull() && colors_->GetColor(shape, XCAFDoc_ColorSurf, color)) return hex_of(color);
    return "";
  }

  void read_validation(const TDF_Label &label, Product &product) const {
    Handle(XCAFDoc_Volume) volume;
    Handle(XCAFDoc_Area) area;
    Handle(XCAFDoc_Centroid) centroid;
    label.FindAttribute(XCAFDoc_Volume::GetID(), volume);
    label.FindAttribute(XCAFDoc_Area::GetID(), area);
    label.FindAttribute(XCAFDoc_Centroid::GetID(), centroid);
    if (!volume.IsNull() || !area.IsNull()) {
      product.has_validation = true;
      product.volume = volume.IsNull() ? 0 : volume->Get();
      product.area = area.IsNull() ? 0 : area->Get();
    }
    if (!centroid.IsNull()) {
      product.has_validation = true;
      product.has_centroid = true;
      const gp_Pnt point = centroid->Get();
      product.centroid[0] = point.X();
      product.centroid[1] = point.Y();
      product.centroid[2] = point.Z();
    }
  }

  // a product tree nests a handful of levels; a hostile file must not recurse the stack away
  static constexpr int kMaxDepth = 64;
  int depth_ = 0;

  struct Depth {
    int &level;
    explicit Depth(int &value) : level(value) {
      if (++level > kMaxDepth) throw std::runtime_error("the product tree nests deeper than 64 levels");
    }
    ~Depth() { --level; }
  };

  int visit(const TDF_Label &label) {
    const Depth guard(depth_);
    TCollection_AsciiString entry;
    TDF_Tool::Entry(label, entry);
    const std::string key(entry.ToCString());
    const auto found = known_.find(key);
    if (found != known_.end()) return found->second;
    const int index = static_cast<int>(products_.size());
    known_[key] = index;
    products_.emplace_back();
    labels_.push_back(label);
    products_[index].name = name_of(label);
    products_[index].assembly = XCAFDoc_ShapeTool::IsAssembly(label);
    products_[index].color = colour_of(label, XCAFDoc_ShapeTool::GetShape(label));
    Handle(TColStd_HSequenceOfExtendedString) layer_names;
    if (layers_->GetLayers(label, layer_names) && !layer_names.IsNull()) {
      for (Standard_Integer i = 1; i <= layer_names->Length(); ++i)
        products_[index].layers.push_back(std::string(TCollection_AsciiString(layer_names->Value(i), '?').ToCString()));
    }
    Product probe;
    read_validation(label, probe);
    products_[index].has_validation = probe.has_validation;
    products_[index].volume = probe.volume;
    products_[index].area = probe.area;
    products_[index].has_centroid = probe.has_centroid;
    for (int k = 0; k < 3; ++k) products_[index].centroid[k] = probe.centroid[k];

    if (products_[index].assembly) {
      TDF_LabelSequence components;
      XCAFDoc_ShapeTool::GetComponents(label, components);
      for (Standard_Integer i = 1; i <= components.Length(); ++i) {
        const TDF_Label component = components.Value(i);
        TDF_Label referred;
        if (!XCAFDoc_ShapeTool::GetReferredShape(component, referred)) continue;
        const int child = visit(referred);
        std::string name = name_of(component);
        if (name.empty()) name = products_[child].name;
        occurrences_.push_back({index, child, name, XCAFDoc_ShapeTool::GetLocation(component).Transformation()});
      }
      return index;
    }
    read_solids(label, index);
    return index;
  }

  void read_solids(const TDF_Label &label, int index) {
    const TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(label);
    if (shape.IsNull()) return;
    const auto solids = distinct(shape, TopAbs_SOLID);
    const auto loose_shells = outside(shape, TopAbs_SHELL, TopAbs_SOLID);
    const auto loose_faces = outside(shape, TopAbs_FACE, TopAbs_SHELL);
    solid_count += solids.Extent();
    shell_count += count_of(shape, TopAbs_SHELL);
    face_count += count_of(shape, TopAbs_FACE);
    for (const TopoDS_Shape &shell : loose_shells)
      if (!BRep_Tool::IsClosed(TopoDS::Shell(shell))) ++open_shells;
    struct Named {
      Candidate candidate;
      std::string name;
      std::string color;
    };
    std::vector<Named> candidates;
    for (int i = 1; i <= solids.Extent(); ++i) {
      if (is_tessellated(solids(i))) {
        ++tessellated;
        continue;
      }
      TDF_Label sub;
      std::string name, color;
      if (shapes_->FindSubShape(label, solids(i), sub)) {
        name = name_of(sub);
        color = colour_of(sub, solids(i));
      }
      if (name.empty() && solids.Extent() == 1) name = products_[index].name;
      if (color.empty()) color = products_[index].color;
      candidates.push_back({{solids(i), is_valid(solids(i)), false}, name, color});
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
    if (!loose.empty() && options_.sew) {
      for (Candidate &sewn : sew_loose(loose, options_.precision, skipped)) candidates.push_back({sewn, "", products_[index].color});
    } else if (!loose.empty()) {
      skipped.push_back(std::to_string(loose.size()) + " loose shells / faces in '" + products_[index].name + "' (sew is off)");
    }
    for (const Named &named : candidates) {
      JsonWriter report;
      write_report(report, named.candidate, options_);
      std::string text = report.text();
      text.pop_back();  // the closing brace: name and colour are appended
      JsonWriter extra;
      extra.begin_object().key("name").string(named.name).key("color").string(named.color).end_object();
      const std::string tail = extra.text();
      solids_.push_back(text + "," + tail.substr(1));
      products_[index].solids.push_back(static_cast<int>(solids_.size()) - 1);
    }
  }
};

}  // namespace

rust::String xde_import_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew) {
  const std::string content(text.data(), text.size());
  const Options options{precision, max_tolerance, heal, sew};
  Interface_Static::SetIVal("read.stepcaf.subshapes.name", 1);
  STEPCAFControl_Reader reader;
  reader.SetColorMode(Standard_True);
  reader.SetNameMode(Standard_True);
  reader.SetLayerMode(Standard_True);
  reader.SetPropsMode(Standard_True);
  reader.SetMatMode(Standard_False);
  reader.SetGDTMode(Standard_True);
  reader.SetSHUOMode(Standard_False);
  std::istringstream stream(content);
  if (reader.ReadStream("in.step", stream) != IFSelect_RetDone)
    return error_json("unreadable", "the file is not a readable ISO 10303-21 STEP file");
  const int file_roots = reader.NbRootsForTransfer();
  XcafDocument holder;
  const Handle(TDocStd_Document) &document = holder.document;
  if (file_roots == 0 || !reader.Transfer(document)) {
    const bool tessellated = content.find("TESSELLATED_") != std::string::npos || content.find("TRIANGULATED_FACE") != std::string::npos ||
                             content.find("COMPLEX_TRIANGULATED") != std::string::npos;
    if (tessellated) return error_json("tessellated_only", "the file holds TESSELLATED_* geometry only; the B-rep reader transferred nothing");
    return error_json("unreadable", std::to_string(file_roots) + " root entities, none transferred to a shape");
  }
  TreeReader tree(document, options);
  tree.session_ = reader.Reader().WS();
  tree.content_ = &content;
  tree.read();
  return tree.finish(file_roots);
}

}  // namespace llull

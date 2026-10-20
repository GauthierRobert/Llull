// XDE (XCAF) exchange facade of the native kernel (XCH 04 M2..M4): AP242 / AP214 / AP203 writer with product structure, names, colours,
// layers, materials and geometric validation properties (STEPCAFControl_Writer), the matching product-tree reader, and IGES. The host builds a
// product list + placed uses (`XdeDoc`, no OCAF types cross the bridge) and the C++ side writes the document; reads answer JSON text.
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DimTolTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <gp_Trsf.hxx>

#include "llull-kernel-occt/cpp/facade.hxx"

namespace llull {

struct XdeSolid {
  TopoDS_Shape shape;
  std::string name;
  std::string color;
};

// Semantic PMI of one product, attached to faces of its shape (0-based `TopExp::MapShapes` indices over the product's shape).
// One extra attribute of a PMI item (modifiers, material requirement, ...): `key` names it, `text` / `number` carry its value.
struct XdePmiAttr {
  std::string key;
  std::string text;
  double number = 0;
};

struct XdePmiDatum {
  std::string label;
  std::vector<int> faces;
  std::vector<XdePmiAttr> attrs;
};

struct XdePmiTolerance {
  std::string characteristic;
  double value = 0;
  bool diameter_zone = false;
  std::vector<int> faces;
  std::vector<std::string> datums;  // labels in reference order (primary first)
  std::vector<XdePmiAttr> attrs;
};

struct XdePmiDimension {
  std::string type;
  double value = 0;
  bool has_tolerance = false;
  double plus = 0;
  double minus = 0;
  std::vector<int> faces;
  std::vector<int> faces_second;  // locations: the second feature set
  std::vector<XdePmiAttr> attrs;
};

struct XdeProduct {
  std::vector<XdePmiDatum> pmi_datums;
  std::vector<XdePmiTolerance> pmi_tolerances;
  std::vector<XdePmiDimension> pmi_dimensions;
  std::string name;
  std::string description;
  std::string color;
  std::string layer;
  std::string material;
  double density = -1;
  std::vector<XdeSolid> solids;
  std::vector<double> validation;  // volume, area, cx, cy, cz in the document unit; empty = none
};

struct XdeUse {
  int parent;  // product index, -1 = the root assembly
  int product;
  std::string name;
  gp_Trsf placement;
};

// A fresh XCAF document, closed again on every path (the application keeps documents alive until they are closed).
struct XcafDocument {
  Handle(TDocStd_Document) document;
  XcafDocument() { XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", document); }
  ~XcafDocument() { XCAFApp_Application::GetApplication()->Close(document); }
  XcafDocument(const XcafDocument &) = delete;
  XcafDocument &operator=(const XcafDocument &) = delete;
};

class XdeDoc {
 public:
  std::vector<XdeProduct> products;
  std::vector<XdeUse> uses;
};

std::unique_ptr<XdeDoc> new_xde_doc();
int32_t xde_product(XdeDoc &doc, rust::Str name, rust::Str description, rust::Str color, rust::Str layer, rust::Str material,
                    double density);
void xde_product_solid(XdeDoc &doc, int32_t product, const Shape &shape, rust::Str name, rust::Str color);
void xde_product_validation(XdeDoc &doc, int32_t product, rust::Slice<const double> values);
void xde_product_pmi_datum(XdeDoc &doc, int32_t product, rust::Str label, rust::Slice<const int32_t> faces);
// datums: labels separated by '|' in reference order (primary first).
void xde_product_pmi_tolerance(XdeDoc &doc, int32_t product, rust::Str characteristic, double value, bool diameter_zone,
                               rust::Slice<const int32_t> faces, rust::Str datums);
void xde_product_pmi_dimension(XdeDoc &doc, int32_t product, rust::Str type, double value, bool has_tolerance, double plus, double minus,
                               rust::Slice<const int32_t> faces, rust::Slice<const int32_t> faces_second);
// `item` = "datum" | "tolerance" | "dimension"; `index` = position of the item in its product list (the one just added).
void xde_product_pmi_attr(XdeDoc &doc, int32_t product, rust::Str item, int32_t index, rust::Str key, rust::Str text, double number);
void xde_use(XdeDoc &doc, int32_t parent, int32_t product, rust::Str name, rust::Slice<const double> rotation,
             rust::Slice<const double> position);

// PMI (xde_pmi.cxx): attach a product's semantic PMI to the faces of `shape` under `product`; read every PMI of a document, as one JSON object per
// product index ({ datums, tolerances, dimensions }); `unmapped` counts items that name no known product face or an unknown characteristic.
void write_product_pmi(const Handle(XCAFDoc_ShapeTool) & shapes, const TDF_Label &main, const TDF_Label &product, const TopoDS_Shape &shape,
                       const XdeProduct &spec);
std::map<int, std::string> read_pmi(const Handle(XCAFDoc_DimTolTool) & tool, const std::map<std::string, int> &products,
                                    const std::map<int, TopoDS_Shape> &shape_of, const Handle(XSControl_WorkSession) & session, const std::string &content,
                                    int &unmapped);

// One AP242 / AP214 / AP203 file (`schema` = DESTEP_Parameters::WriteMode_StepSchema 3, 4 or 5) written in `unit` (mm, cm, m, in, ft; the
// numbers are the document's own). `root_name` names the root assembly when any use has parent -1; `root_validation` is its GVP (volume,
// area, cx, cy, cz) or empty. Empty string = the writer could not transfer the document.
rust::String xde_write(XdeDoc &doc, int32_t schema, rust::Str unit, rust::Str file_name, rust::Str timestamp, rust::Str originating_system,
                       rust::Str root_name, rust::Slice<const double> root_validation);

// STEP read into XDE: the product tree as JSON (see xde_read.cxx), solids healed like import_step_json.
rust::String xde_import_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew);

// IGES (TKDEIGES, compiled only with LLULL_HAS_IGES): `igesAvailable`, read + sew + heal as JSON, write of B-rep solids.
bool iges_available();
rust::String iges_import_json(rust::Str text, double precision, double max_tolerance, bool heal, bool sew, double sewing_tolerance);
rust::String iges_write(XdeDoc &doc, bool brep_mode, rust::Str unit);

}  // namespace llull

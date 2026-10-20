// XDE writer (XCH 04 M2, TR-XCH-01/04/06/07): the host's product list and placed uses become an XCAF document (shape tool for the product tree,
// colour / layer / material tools, TDataStd_Name for names, XCAFDoc_Volume / Area / Centroid for the geometric validation properties) and
// STEPCAFControl_Writer writes it in the requested schema, in the document's own length unit.
#include <cmath>
#include <functional>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <APIHeaderSection_MakeHeader.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRep_Builder.hxx>
#include <DESTEP_Parameters.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Quantity_Color.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <StepBasic_Product.hxx>
#include <StepData_StepModel.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_Area.hxx>
#include <XCAFDoc_Centroid.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <XCAFDoc_MaterialTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Volume.hxx>
#include <gp_Ax1.hxx>
#include <gp_Pnt.hxx>

#include "llull-kernel-occt/cpp/xde.hxx"

namespace llull {

namespace {

struct UnitInfo {
  double metres;
  int step_enum;  // UnitsMethods_LengthUnit as DESTEP_Parameters::WriteUnit
};

UnitInfo unit_of(const std::string &name) {
  if (name == "mm") return {0.001, 2};
  if (name == "cm") return {0.01, 10};
  if (name == "m") return {1.0, 6};
  if (name == "in") return {0.0254, 1};
  if (name == "ft") return {0.3048, 4};
  throw std::invalid_argument("unknown length unit '" + name + "'");
}

std::string text_of(rust::Str value) { return std::string(value.data(), value.size()); }

bool parse_color(const std::string &hex, Quantity_Color &color) {
  if (hex.size() != 7 || hex[0] != '#') return false;
  int channel[3];
  for (int i = 0; i < 3; ++i) {
    try {
      channel[i] = std::stoi(hex.substr(1 + 2 * i, 2), nullptr, 16);
    } catch (const std::exception &) {
      return false;
    }
  }
  color = Quantity_Color(channel[0] / 255.0, channel[1] / 255.0, channel[2] / 255.0, Quantity_TOC_sRGB);
  return true;
}

// llull placement M = T . Rx . Ry . Rz (same as exchange.cxx `placement`).
gp_Trsf placement_of(rust::Slice<const double> rotation, rust::Slice<const double> position) {
  if (rotation.size() != 3 || position.size() != 3) throw std::invalid_argument("use: need 3 rotation and 3 position components");
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

// The writer works on a private copy with its location baked in: XCAF keeps a product's shape at the identity location, and the STEP transfer
// completes the shape in place (curves, parameters), which would change the bytes of the next export of the same cached shape.
TopoDS_Shape detached(const TopoDS_Shape &shape) {
  const TopoDS_Shape copy = BRepBuilderAPI_Copy(shape, Standard_True, Standard_False).Shape();
  if (copy.Location().IsIdentity()) return copy;
  return BRepBuilderAPI_Transform(copy, copy.Location().Transformation(), Standard_True).Shape();
}

void set_name(const TDF_Label &label, const std::string &name) {
  if (!name.empty()) TDataStd_Name::Set(label, TCollection_ExtendedString(name.c_str(), Standard_True));
}

class Builder {
 public:
  Builder(XdeDoc &source, const Handle(TDocStd_Document) & document)
      : source_(source),
        main_(document->Main()),
        shapes_(XCAFDoc_DocumentTool::ShapeTool(document->Main())),
        colors_(XCAFDoc_DocumentTool::ColorTool(document->Main())),
        layers_(XCAFDoc_DocumentTool::LayerTool(document->Main())),
        materials_(XCAFDoc_DocumentTool::MaterialTool(document->Main())),
        labels_(source.products.size()),
        state_(source.products.size(), 0) {}

  void build(const std::string &root_name, rust::Slice<const double> root_validation) {
    bool has_root = false;
    for (const XdeUse &use : source_.uses) has_root = has_root || use.parent < 0;
    if (has_root) {
      const TDF_Label root = shapes_->NewShape();
      set_name(root, root_name);
      for (const XdeUse &use : source_.uses)
        if (use.parent < 0) place(root, use);
      validation(root, root_validation);
    }
    for (size_t p = 0; p < source_.products.size(); ++p) label_of(static_cast<int>(p));
    shapes_->UpdateAssemblies();
  }

 private:
  XdeDoc &source_;
  TDF_Label main_;
  Handle(XCAFDoc_ShapeTool) shapes_;
  Handle(XCAFDoc_ColorTool) colors_;
  Handle(XCAFDoc_LayerTool) layers_;
  Handle(XCAFDoc_MaterialTool) materials_;
  std::vector<TDF_Label> labels_;
  std::vector<int> state_;  // 0 = not built, 1 = building, 2 = built

  void place(const TDF_Label &assembly, const XdeUse &use) {
    const TDF_Label part = label_of(use.product);
    const TDF_Label component = shapes_->AddComponent(assembly, part, TopLoc_Location(use.placement));
    set_name(component, use.name);
  }

  void validation(const TDF_Label &label, rust::Slice<const double> values) {
    if (values.size() != 5) return;
    XCAFDoc_Volume::Set(label, values[0]);
    XCAFDoc_Area::Set(label, values[1]);
    XCAFDoc_Centroid::Set(label, gp_Pnt(values[2], values[3], values[4]));
  }

  void colour(const TDF_Label &label, const std::string &hex) {
    Quantity_Color color;
    if (parse_color(hex, color)) colors_->SetColor(label, color, XCAFDoc_ColorSurf);
  }

  TDF_Label label_of(int index) {
    if (index < 0 || static_cast<size_t>(index) >= labels_.size()) throw std::invalid_argument("use: unknown product");
    if (state_[index] == 2) return labels_[index];
    if (state_[index] == 1) throw std::invalid_argument("products reference each other in a cycle");
    state_[index] = 1;
    const XdeProduct &product = source_.products[index];
    std::vector<const XdeUse *> children;
    for (const XdeUse &use : source_.uses)
      if (use.parent == index) children.push_back(&use);

    TopoDS_Shape own;
    if (product.solids.size() == 1) {
      own = product.solids[0].shape;
    } else if (product.solids.size() > 1) {
      TopoDS_Compound compound;
      BRep_Builder builder;
      builder.MakeCompound(compound);
      for (const XdeSolid &solid : product.solids) builder.Add(compound, solid.shape);
      own = compound;
    }
    TDF_Label label;
    if (children.empty()) {
      if (own.IsNull()) throw std::invalid_argument("product '" + product.name + "' has no shape and no placed use");
      label = shapes_->AddShape(own, Standard_False, Standard_False);
    } else {
      label = shapes_->NewShape();
      for (const XdeUse *use : children) place(label, *use);
      if (!own.IsNull()) {
        const TDF_Label solids = shapes_->AddShape(own, Standard_False, Standard_False);
        set_name(solids, product.name + " (solids)");
        decorate_solids(solids, product);
        set_name(shapes_->AddComponent(label, solids, TopLoc_Location()), product.name);
      }
    }
    set_name(label, product.name);
    if (children.empty()) decorate_solids(label, product);
    if (!product.color.empty()) colour(label, product.color);
    if (!product.layer.empty()) layers_->SetLayer(label, TCollection_ExtendedString(product.layer.c_str(), Standard_True));
    if (!product.material.empty() && product.density > 0)
      materials_->SetMaterial(label, new TCollection_HAsciiString(product.material.c_str()), new TCollection_HAsciiString(""),
                              product.density, new TCollection_HAsciiString("density"), new TCollection_HAsciiString("g/cm3"));
    validation(label, rust::Slice<const double>(product.validation.data(), product.validation.size()));
    labels_[index] = label;
    state_[index] = 2;
    return label;
  }

  // Several solids in one product: each is a sub-shape label carrying its own name and colour.
  void decorate_solids(const TDF_Label &label, const XdeProduct &product) {
    if (product.solids.size() == 1) {
      if (product.color.empty()) colour(label, product.solids[0].color);
      return;
    }
    for (const XdeSolid &solid : product.solids) {
      const TDF_Label sub = shapes_->AddSubShape(label, solid.shape);
      if (sub.IsNull()) continue;
      set_name(sub, solid.name);
      colour(sub, solid.color);
    }
  }
};

}  // namespace

std::unique_ptr<XdeDoc> new_xde_doc() { return std::make_unique<XdeDoc>(); }

int32_t xde_product(XdeDoc &doc, rust::Str name, rust::Str description, rust::Str color, rust::Str layer, rust::Str material,
                    double density) {
  XdeProduct product;
  product.name = text_of(name);
  product.description = text_of(description);
  product.color = text_of(color);
  product.layer = text_of(layer);
  product.material = text_of(material);
  product.density = density;
  doc.products.push_back(std::move(product));
  return static_cast<int32_t>(doc.products.size() - 1);
}

void xde_product_solid(XdeDoc &doc, int32_t product, const Shape &shape, rust::Str name, rust::Str color) {
  if (product < 0 || static_cast<size_t>(product) >= doc.products.size()) throw std::invalid_argument("product: unknown index");
  doc.products[static_cast<size_t>(product)].solids.push_back({detached(shape.shape), text_of(name), text_of(color)});
}

void xde_product_validation(XdeDoc &doc, int32_t product, rust::Slice<const double> values) {
  if (product < 0 || static_cast<size_t>(product) >= doc.products.size()) throw std::invalid_argument("product: unknown index");
  if (values.size() != 5) throw std::invalid_argument("validation: need volume, area and 3 centroid components");
  doc.products[static_cast<size_t>(product)].validation.assign(values.begin(), values.end());
}

void xde_use(XdeDoc &doc, int32_t parent, int32_t product, rust::Str name, rust::Slice<const double> rotation,
             rust::Slice<const double> position) {
  doc.uses.push_back({parent, product, text_of(name), placement_of(rotation, position)});
}

rust::String xde_write(XdeDoc &doc, int32_t schema, rust::Str unit, rust::Str file_name, rust::Str timestamp, rust::Str originating_system,
                       rust::Str root_name, rust::Slice<const double> root_validation) {
  if (schema != 3 && schema != 4 && schema != 5) throw std::invalid_argument("schema must be 3 (AP203), 4 (AP214) or 5 (AP242)");
  const UnitInfo info = unit_of(text_of(unit));
  XcafDocument holder;
  const Handle(TDocStd_Document) &document = holder.document;
  XCAFDoc_DocumentTool::SetLengthUnit(document, info.metres);
  Builder(doc, document).build(text_of(root_name), root_validation);

  DESTEP_Parameters parameters;
  parameters.InitFromStatic();
  parameters.WriteSchema = static_cast<DESTEP_Parameters::WriteMode_StepSchema>(schema);
  parameters.WriteUnit = static_cast<UnitsMethods_LengthUnit>(info.step_enum);
  parameters.WriteAssembly = DESTEP_Parameters::WriteMode_Assembly_Auto;
  parameters.WriteSubshapeNames = true;
  STEPCAFControl_Writer writer;
  writer.SetColorMode(Standard_True);
  writer.SetNameMode(Standard_True);
  writer.SetLayerMode(Standard_True);
  writer.SetPropsMode(Standard_True);
  writer.SetMaterialMode(Standard_True);
  writer.SetDimTolMode(Standard_False);
  if (!writer.Transfer(document, parameters, STEPControl_AsIs)) return rust::String();
  const Handle(StepData_StepModel) model = writer.ChangeWriter().Model();
  // the writer leaves the PRODUCT description empty: it carries the host's (an entity's group name)
  std::map<std::string, std::string> descriptions;
  for (const XdeProduct &product : doc.products)
    if (!product.description.empty()) descriptions.emplace(product.name, product.description);
  for (Standard_Integer i = 1; i <= model->NbEntities(); ++i) {
    const Handle(StepBasic_Product) step_product = Handle(StepBasic_Product)::DownCast(model->Value(i));
    if (step_product.IsNull() || step_product->Id().IsNull()) continue;
    const auto found = descriptions.find(step_product->Id()->ToCString());
    if (found != descriptions.end()) step_product->SetDescription(new TCollection_HAsciiString(found->second.c_str()));
  }
  APIHeaderSection_MakeHeader header(model);
  header.SetName(new TCollection_HAsciiString(text_of(file_name).c_str()));
  if (!timestamp.empty()) header.SetTimeStamp(new TCollection_HAsciiString(text_of(timestamp).c_str()));
  header.SetOriginatingSystem(new TCollection_HAsciiString(text_of(originating_system).c_str()));
  header.SetDescriptionValue(1, new TCollection_HAsciiString("llull export"));
  header.Apply(model);
  std::ostringstream text;
  if (writer.WriteStream(text) != IFSelect_RetDone) return rust::String();
  return rust::String(text.str());
}

}  // namespace llull

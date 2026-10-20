// Semantic PMI transport (XCH 04 V1 hook for 03 GD&T M6): datums, size / location dimensions and geometric tolerances attached to FACES of a product's shape
// through XCAFDoc_DimTolTool, written by STEPCAFControl_Writer (AP242) and read back by STEPCAFControl_Reader. Faces are numbered like the port
// (`TopExp::MapShapes` order over the product's shape, 0-based). The neutral vocabulary here (characteristic / dimension names) is the contract of
// docs/aerospace/04-interop-ap242-jt-iges/TECHNICAL_SPEC.md "PMI transport"; 03 maps its own model onto it.
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <TCollection_AsciiString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <XCAFDimTolObjects_DatumObject.hxx>
#include <XCAFDimTolObjects_DimensionObject.hxx>
#include <XCAFDimTolObjects_GeomToleranceObject.hxx>
#include <XCAFDoc_Datum.hxx>
#include <XCAFDoc_DimTolTool.hxx>
#include <XCAFDoc_Dimension.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_GeomTolerance.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include "llull-kernel-occt/cpp/xde.hxx"
#include "llull-kernel-occt/cpp/json_writer.hxx"

namespace llull {

namespace {

struct Characteristic {
  const char *name;
  XCAFDimTolObjects_GeomToleranceType type;
};

const Characteristic kCharacteristics[] = {
    {"angularity", XCAFDimTolObjects_GeomToleranceType_Angularity},
    {"circular_runout", XCAFDimTolObjects_GeomToleranceType_CircularRunout},
    {"circularity", XCAFDimTolObjects_GeomToleranceType_CircularityOrRoundness},
    {"coaxiality", XCAFDimTolObjects_GeomToleranceType_Coaxiality},
    {"concentricity", XCAFDimTolObjects_GeomToleranceType_Concentricity},
    {"cylindricity", XCAFDimTolObjects_GeomToleranceType_Cylindricity},
    {"flatness", XCAFDimTolObjects_GeomToleranceType_Flatness},
    {"parallelism", XCAFDimTolObjects_GeomToleranceType_Parallelism},
    {"perpendicularity", XCAFDimTolObjects_GeomToleranceType_Perpendicularity},
    {"position", XCAFDimTolObjects_GeomToleranceType_Position},
    {"profile_line", XCAFDimTolObjects_GeomToleranceType_ProfileOfLine},
    {"profile_surface", XCAFDimTolObjects_GeomToleranceType_ProfileOfSurface},
    {"straightness", XCAFDimTolObjects_GeomToleranceType_Straightness},
    {"symmetry", XCAFDimTolObjects_GeomToleranceType_Symmetry},
    {"total_runout", XCAFDimTolObjects_GeomToleranceType_TotalRunout},
};

struct DimensionKind {
  const char *name;
  XCAFDimTolObjects_DimensionType type;
  bool two_sided;  // a location: between two feature sets
};

const DimensionKind kDimensions[] = {
    {"size_diameter", XCAFDimTolObjects_DimensionType_Size_Diameter, false},
    {"size_radius", XCAFDimTolObjects_DimensionType_Size_Radius, false},
    {"size_spherical_diameter", XCAFDimTolObjects_DimensionType_Size_SphericalDiameter, false},
    {"size_spherical_radius", XCAFDimTolObjects_DimensionType_Size_SphericalRadius, false},
    {"size_thickness", XCAFDimTolObjects_DimensionType_Size_Thickness, false},
    {"size_curve_length", XCAFDimTolObjects_DimensionType_Size_CurveLength, false},
    {"size_angular", XCAFDimTolObjects_DimensionType_Size_Angular, false},
    {"location_linear_distance", XCAFDimTolObjects_DimensionType_Location_LinearDistance, true},
    {"location_angular", XCAFDimTolObjects_DimensionType_Location_Angular, true},
};

// Face labels of `faces` (0-based port indices over `shape`), created as sub-shape labels of `product`.
TDF_LabelSequence face_labels(const Handle(XCAFDoc_ShapeTool) & shapes, const TDF_Label &product, const TopoDS_Shape &shape,
                              const std::vector<int> &faces) {
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(shape, TopAbs_FACE, map);
  TDF_LabelSequence labels;
  for (const int face : faces) {
    if (face < 0 || face >= map.Extent()) throw std::invalid_argument("pmi: face index " + std::to_string(face) + " is not a face of the product");
    const TDF_Label label = shapes->AddSubShape(product, map(face + 1));
    if (label.IsNull()) throw std::invalid_argument("pmi: face " + std::to_string(face) + " could not be labelled");
    labels.Append(label);
  }
  return labels;
}

Handle(TCollection_HAsciiString) ascii(const std::string &text) { return new TCollection_HAsciiString(text.c_str()); }

}  // namespace

void write_product_pmi(const Handle(XCAFDoc_ShapeTool) & shapes, const TDF_Label &main, const TDF_Label &product, const TopoDS_Shape &shape,
                       const XdeProduct &spec) {
  if (spec.pmi_datums.empty() && spec.pmi_tolerances.empty() && spec.pmi_dimensions.empty()) return;
  const Handle(XCAFDoc_DimTolTool) tool = XCAFDoc_DocumentTool::DimTolTool(main);
  std::map<std::string, TDF_Label> datum_label;
  int position = 0;
  for (const XdePmiDatum &datum : spec.pmi_datums) {
    const TDF_Label label = tool->AddDatum();
    tool->SetDatum(face_labels(shapes, product, shape, datum.faces), label);
    const Handle(XCAFDimTolObjects_DatumObject) object = new XCAFDimTolObjects_DatumObject();
    object->SetName(ascii(datum.label));
    object->SetPosition(++position);
    Handle(XCAFDoc_Datum) attribute;
    if (label.FindAttribute(XCAFDoc_Datum::GetID(), attribute)) attribute->SetObject(object);
    datum_label[datum.label] = label;
  }
  for (const XdePmiTolerance &tolerance : spec.pmi_tolerances) {
    const Characteristic *found = nullptr;
    for (const Characteristic &entry : kCharacteristics)
      if (tolerance.characteristic == entry.name) found = &entry;
    if (found == nullptr) throw std::invalid_argument("pmi: unknown characteristic '" + tolerance.characteristic + "'");
    const TDF_Label label = tool->AddGeomTolerance();
    tool->SetGeomTolerance(face_labels(shapes, product, shape, tolerance.faces), label);
    const Handle(XCAFDimTolObjects_GeomToleranceObject) object = new XCAFDimTolObjects_GeomToleranceObject();
    object->SetType(found->type);
    object->SetValue(tolerance.value);
    object->SetTypeOfValue(tolerance.diameter_zone ? XCAFDimTolObjects_GeomToleranceTypeValue_Diameter : XCAFDimTolObjects_GeomToleranceTypeValue_None);
    Handle(XCAFDoc_GeomTolerance) attribute;
    if (label.FindAttribute(XCAFDoc_GeomTolerance::GetID(), attribute)) attribute->SetObject(object);
    for (const std::string &name : tolerance.datums) {
      const auto referred = datum_label.find(name);
      if (referred == datum_label.end()) throw std::invalid_argument("pmi: tolerance refers to datum '" + name + "' that the product does not define");
      tool->SetDatumToGeomTol(referred->second, label);
    }
  }
  for (const XdePmiDimension &dimension : spec.pmi_dimensions) {
    const DimensionKind *found = nullptr;
    for (const DimensionKind &entry : kDimensions)
      if (dimension.type == entry.name) found = &entry;
    if (found == nullptr) throw std::invalid_argument("pmi: unknown dimension type '" + dimension.type + "'");
    const TDF_Label label = tool->AddDimension();
    const TDF_LabelSequence first = face_labels(shapes, product, shape, dimension.faces);
    if (found->two_sided) {
      tool->SetDimension(first, face_labels(shapes, product, shape, dimension.faces_second), label);
    } else {
      tool->SetDimension(first, TDF_LabelSequence(), label);
    }
    const Handle(XCAFDimTolObjects_DimensionObject) object = new XCAFDimTolObjects_DimensionObject();
    object->SetType(found->type);
    object->SetValue(dimension.value);
    if (dimension.has_tolerance) {
      // both deviations are magnitudes: nominal - minus <= x <= nominal + plus (the STEP file stores them unsigned)
      object->SetUpperTolValue(std::fabs(dimension.plus));
      object->SetLowerTolValue(std::fabs(dimension.minus));
    }
    Handle(XCAFDoc_Dimension) attribute;
    if (label.FindAttribute(XCAFDoc_Dimension::GetID(), attribute)) attribute->SetObject(object);
  }
}

namespace {

std::string entry_of(const TDF_Label &label) {
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return std::string(entry.ToCString());
}

// The product (index in `products`) whose label is the nearest ancestor of `label`, or -1.
int owner_of(const TDF_Label &label, const std::map<std::string, int> &products) {
  for (TDF_Label at = label; !at.IsNull(); at = at.Father()) {
    const auto found = products.find(entry_of(at));
    if (found != products.end()) return found->second;
  }
  return -1;
}

}  // namespace

// One JSON object per product index holding that product's PMI (absent entries = none); `shape_of[index]` numbers the faces.
std::map<int, std::string> read_pmi(const Handle(XCAFDoc_DimTolTool) & tool, const std::map<std::string, int> &products,
                                    const std::map<int, TopoDS_Shape> &shape_of, int &unmapped) {
  struct Collected {
    JsonWriter datums, tolerances, dimensions;
    int datum_count = 0, tolerance_count = 0, dimension_count = 0;
    Collected() {
      datums.begin_array();
      tolerances.begin_array();
      dimensions.begin_array();
    }
  };
  std::map<int, Collected> collected;
  const auto faces_of = [&](const TDF_LabelSequence &labels, int &owner, std::vector<int> &indices) {
    for (Standard_Integer i = 1; i <= labels.Length(); ++i) {
      const TDF_Label label = labels.Value(i);
      const int product = owner_of(label, products);
      const auto shape = shape_of.find(product);
      if (shape == shape_of.end()) continue;
      const TopoDS_Shape face = XCAFDoc_ShapeTool::GetShape(label);
      if (face.IsNull()) continue;
      TopTools_IndexedMapOfShape map;
      TopExp::MapShapes(shape->second, TopAbs_FACE, map);
      const int index = map.FindIndex(face) - 1;
      if (index < 0) continue;
      if (owner < 0) owner = product;
      if (owner == product) indices.push_back(index);
    }
  };
  const auto write_faces = [](JsonWriter &out, const char *key, const std::vector<int> &indices) {
    out.key(key).begin_array();
    for (const int index : indices) out.integer(index);
    out.end_array();
  };

  std::set<std::string> seen_datums;
  TDF_LabelSequence datum_labels;
  tool->GetDatumLabels(datum_labels);
  std::map<std::string, std::string> datum_name;
  for (Standard_Integer i = 1; i <= datum_labels.Length(); ++i) {
    const TDF_Label label = datum_labels.Value(i);
    Handle(XCAFDoc_Datum) attribute;
    if (!label.FindAttribute(XCAFDoc_Datum::GetID(), attribute)) continue;
    const Handle(XCAFDimTolObjects_DatumObject) object = attribute->GetObject();
    std::string name = object.IsNull() || object->GetName().IsNull() ? "" : object->GetName()->ToCString();
    if (name.empty() && !attribute->GetName().IsNull()) name = attribute->GetName()->ToCString();
    datum_name[entry_of(label)] = name;
    TDF_LabelSequence first, second;
    XCAFDoc_DimTolTool::GetRefShapeLabel(label, first, second);
    int owner = -1;
    std::vector<int> indices;
    faces_of(first, owner, indices);
    if (owner < 0) {
      ++unmapped;
      continue;
    }
    // the writer repeats a datum for every tolerance that refers to it: one entry per (label, faces)
    std::string signature = std::to_string(owner) + "|" + name;
    for (const int index : indices) signature += "," + std::to_string(index);
    if (!seen_datums.insert(signature).second) continue;
    Collected &into = collected[owner];
    into.datums.begin_object().key("label").string(name);
    write_faces(into.datums, "faces", indices);
    into.datums.end_object();
    ++into.datum_count;
  }

  TDF_LabelSequence tolerance_labels;
  tool->GetGeomToleranceLabels(tolerance_labels);
  for (Standard_Integer i = 1; i <= tolerance_labels.Length(); ++i) {
    const TDF_Label label = tolerance_labels.Value(i);
    Handle(XCAFDoc_GeomTolerance) attribute;
    if (!label.FindAttribute(XCAFDoc_GeomTolerance::GetID(), attribute)) continue;
    const Handle(XCAFDimTolObjects_GeomToleranceObject) object = attribute->GetObject();
    if (object.IsNull()) continue;
    const char *characteristic = nullptr;
    for (const Characteristic &entry : kCharacteristics)
      if (entry.type == object->GetType()) characteristic = entry.name;
    TDF_LabelSequence first, second;
    XCAFDoc_DimTolTool::GetRefShapeLabel(label, first, second);
    int owner = -1;
    std::vector<int> indices;
    faces_of(first, owner, indices);
    if (characteristic == nullptr || owner < 0) {
      ++unmapped;
      continue;
    }
    TDF_LabelSequence datums;
    XCAFDoc_DimTolTool::GetDatumOfTolerLabels(label, datums);
    Collected &into = collected[owner];
    into.tolerances.begin_object().key("characteristic").string(characteristic).key("value").number(object->GetValue());
    into.tolerances.key("diameterZone").boolean(object->GetTypeOfValue() == XCAFDimTolObjects_GeomToleranceTypeValue_Diameter);
    write_faces(into.tolerances, "faces", indices);
    into.tolerances.key("datums").begin_array();
    for (Standard_Integer k = 1; k <= datums.Length(); ++k) into.tolerances.string(datum_name[entry_of(datums.Value(k))]);
    into.tolerances.end_array().end_object();
    ++into.tolerance_count;
  }

  TDF_LabelSequence dimension_labels;
  tool->GetDimensionLabels(dimension_labels);
  for (Standard_Integer i = 1; i <= dimension_labels.Length(); ++i) {
    const TDF_Label label = dimension_labels.Value(i);
    Handle(XCAFDoc_Dimension) attribute;
    if (!label.FindAttribute(XCAFDoc_Dimension::GetID(), attribute)) continue;
    const Handle(XCAFDimTolObjects_DimensionObject) object = attribute->GetObject();
    if (object.IsNull()) continue;
    const DimensionKind *kind = nullptr;
    for (const DimensionKind &entry : kDimensions)
      if (entry.type == object->GetType()) kind = &entry;
    TDF_LabelSequence first, second;
    XCAFDoc_DimTolTool::GetRefShapeLabel(label, first, second);
    int owner = -1;
    std::vector<int> indices, indices_second;
    faces_of(first, owner, indices);
    faces_of(second, owner, indices_second);
    if (kind == nullptr || owner < 0) {
      ++unmapped;
      continue;
    }
    Collected &into = collected[owner];
    into.dimensions.begin_object().key("type").string(kind->name).key("value").number(object->GetValue());
    if (object->GetUpperTolValue() != 0 || object->GetLowerTolValue() != 0)
      into.dimensions.key("tolerance").begin_object().key("plus").number(object->GetUpperTolValue()).key("minus").number(object->GetLowerTolValue()).end_object();
    write_faces(into.dimensions, "faces", indices);
    if (kind->two_sided) write_faces(into.dimensions, "facesSecond", indices_second);
    into.dimensions.end_object();
    ++into.dimension_count;
  }

  std::map<int, std::string> result;
  for (auto &entry : collected) {
    Collected &item = entry.second;
    item.datums.end_array();
    item.tolerances.end_array();
    item.dimensions.end_array();
    JsonWriter out;
    out.begin_object().key("datums").raw(item.datums.text()).key("tolerances").raw(item.tolerances.text()).key("dimensions").raw(item.dimensions.text());
    out.end_object();
    result[entry.first] = out.text();
  }
  return result;
}

}  // namespace llull

// Semantic PMI transport (XCH 04 V1 hook for 03 GD&T M6): datums, size / location dimensions and geometric tolerances attached to FACES of a product's shape
// through XCAFDoc_DimTolTool, written by STEPCAFControl_Writer (AP242) and read back by STEPCAFControl_Reader. Faces are numbered like the port
// (`TopExp::MapShapes` order over the product's shape, 0-based). The neutral vocabulary here (characteristic / dimension names) is the contract of
// docs/aerospace/04-interop-ap242-jt-iges/TECHNICAL_SPEC.md "PMI transport"; 03 maps its own model onto it.
#include <cmath>
#include <algorithm>
#include <functional>
#include <unordered_map>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <Interface_EntityIterator.hxx>
#include <Interface_Graph.hxx>
#include <StepAP242_ItemIdentifiedRepresentationUsage.hxx>
#include <StepBasic_ConversionBasedUnitAndLengthUnit.hxx>
#include <StepBasic_MeasureWithUnit.hxx>
#include <StepBasic_NamedUnit.hxx>
#include <StepBasic_SiUnitAndLengthUnit.hxx>
#include <StepData_StepModel.hxx>
#include <StepDimTol_AngularityTolerance.hxx>
#include <StepDimTol_CircularRunoutTolerance.hxx>
#include <StepDimTol_CoaxialityTolerance.hxx>
#include <StepDimTol_ConcentricityTolerance.hxx>
#include <StepDimTol_CylindricityTolerance.hxx>
#include <StepDimTol_Datum.hxx>
#include <StepDimTol_DatumFeature.hxx>
#include <StepDimTol_DatumReferenceCompartment.hxx>
#include <StepDimTol_DatumReferenceElement.hxx>
#include <StepDimTol_DatumSystem.hxx>
#include <StepDimTol_DatumTarget.hxx>
#include <StepDimTol_FlatnessTolerance.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRef.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMaxTol.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMod.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndModGeoTolAndPosTol.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndUneqDisGeoTol.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthMaxTol.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthMod.hxx>
#include <StepDimTol_GeometricTolerance.hxx>
#include <StepDimTol_LineProfileTolerance.hxx>
#include <StepDimTol_ParallelismTolerance.hxx>
#include <StepDimTol_PerpendicularityTolerance.hxx>
#include <StepDimTol_PositionTolerance.hxx>
#include <StepDimTol_RoundnessTolerance.hxx>
#include <StepDimTol_StraightnessTolerance.hxx>
#include <StepDimTol_SurfaceProfileTolerance.hxx>
#include <StepDimTol_SymmetryTolerance.hxx>
#include <StepDimTol_ToleranceZone.hxx>
#include <StepDimTol_ToleranceZoneForm.hxx>
#include <StepDimTol_TotalRunoutTolerance.hxx>
#include <StepRepr_DerivedShapeAspect.hxx>
#include <StepRepr_ShapeAspect.hxx>
#include <StepRepr_ShapeAspectDerivingRelationship.hxx>
#include <StepRepr_ShapeAspectRelationship.hxx>
#include <StepShape_DimensionalLocation.hxx>
#include <StepShape_DimensionalSize.hxx>
#include <StepShape_TopologicalRepresentationItem.hxx>
#include <STEPCAFControl_GDTProperty.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TransferBRep.hxx>
#include <Transfer_TransientProcess.hxx>
#include <XSControl_TransferReader.hxx>
#include <XSControl_WorkSession.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <XCAFDimTolObjects_DatumModifWithValue.hxx>
#include <XCAFDimTolObjects_DatumObject.hxx>
#include <XCAFDimTolObjects_DatumSingleModif.hxx>
#include <XCAFDimTolObjects_DimensionFormVariance.hxx>
#include <XCAFDimTolObjects_DimensionGrade.hxx>
#include <XCAFDimTolObjects_DimensionModif.hxx>
#include <XCAFDimTolObjects_DimensionQualifier.hxx>
#include <XCAFDimTolObjects_GeomToleranceMatReqModif.hxx>
#include <XCAFDimTolObjects_GeomToleranceModif.hxx>
#include <XCAFDimTolObjects_GeomToleranceZoneModif.hxx>
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
#include "llull-kernel-occt/cpp/xde_pmi_text.hxx"

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

template <typename E>
struct Named {
  const char *name;
  E value;
};

#define NAMED(prefix, token, label) {label, prefix##_##token}

const Named<XCAFDimTolObjects_GeomToleranceModif> kToleranceModifiers[] = {
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Any_Cross_Section, "any_cross_section"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Common_Zone, "common_zone"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Each_Radial_Element, "each_radial_element"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Free_State, "free_state"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Least_Material_Requirement, "least_material_requirement"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Line_Element, "line_element"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Major_Diameter, "major_diameter"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Maximum_Material_Requirement, "maximum_material_requirement"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Minor_Diameter, "minor_diameter"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Not_Convex, "not_convex"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Pitch_Diameter, "pitch_diameter"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Reciprocity_Requirement, "reciprocity_requirement"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Separate_Requirement, "separate_requirement"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Statistical_Tolerance, "statistical_tolerance"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, Tangent_Plane, "tangent_plane"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, All_Around, "all_around"),
    NAMED(XCAFDimTolObjects_GeomToleranceModif, All_Over, "all_over"),
};

const Named<XCAFDimTolObjects_GeomToleranceZoneModif> kZoneModifiers[] = {
    NAMED(XCAFDimTolObjects_GeomToleranceZoneModif, Projected, "projected"),
    NAMED(XCAFDimTolObjects_GeomToleranceZoneModif, Runout, "runout"),
    NAMED(XCAFDimTolObjects_GeomToleranceZoneModif, NonUniform, "non_uniform"),
};

const Named<XCAFDimTolObjects_GeomToleranceMatReqModif> kMaterialRequirements[] = {
    NAMED(XCAFDimTolObjects_GeomToleranceMatReqModif, M, "maximum"),
    NAMED(XCAFDimTolObjects_GeomToleranceMatReqModif, L, "least"),
};

const Named<XCAFDimTolObjects_DatumSingleModif> kDatumModifiers[] = {
    NAMED(XCAFDimTolObjects_DatumSingleModif, AnyCrossSection, "any_cross_section"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Any_LongitudinalSection, "any_longitudinal_section"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Basic, "basic"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, ContactingFeature, "contacting_feature"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintU, "dof_constraint_u"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintV, "dof_constraint_v"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintW, "dof_constraint_w"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintX, "dof_constraint_x"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintY, "dof_constraint_y"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DegreeOfFreedomConstraintZ, "dof_constraint_z"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, DistanceVariable, "distance_variable"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, FreeState, "free_state"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, LeastMaterialRequirement, "least_material_requirement"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Line, "line"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, MajorDiameter, "major_diameter"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, MaximumMaterialRequirement, "maximum_material_requirement"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, MinorDiameter, "minor_diameter"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Orientation, "orientation"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, PitchDiameter, "pitch_diameter"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Plane, "plane"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Point, "point"),
    NAMED(XCAFDimTolObjects_DatumSingleModif, Translation, "translation"),
};

const Named<XCAFDimTolObjects_DatumModifWithValue> kDatumWithValue[] = {
    NAMED(XCAFDimTolObjects_DatumModifWithValue, CircularOrCylindrical, "circular_or_cylindrical"),
    NAMED(XCAFDimTolObjects_DatumModifWithValue, Distance, "distance"),
    NAMED(XCAFDimTolObjects_DatumModifWithValue, Projected, "projected"),
    NAMED(XCAFDimTolObjects_DatumModifWithValue, Spherical, "spherical"),
};

const Named<XCAFDimTolObjects_DimensionModif> kDimensionModifiers[] = {
    NAMED(XCAFDimTolObjects_DimensionModif, ControlledRadius, "controlled_radius"),
    NAMED(XCAFDimTolObjects_DimensionModif, Square, "square"),
    NAMED(XCAFDimTolObjects_DimensionModif, StatisticalTolerance, "statistical_tolerance"),
    NAMED(XCAFDimTolObjects_DimensionModif, ContinuousFeature, "continuous_feature"),
    NAMED(XCAFDimTolObjects_DimensionModif, TwoPointSize, "two_point_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, LocalSizeDefinedBySphere, "local_size_defined_by_sphere"),
    NAMED(XCAFDimTolObjects_DimensionModif, LeastSquaresAssociationCriterion, "least_squares_association"),
    NAMED(XCAFDimTolObjects_DimensionModif, MaximumInscribedAssociation, "maximum_inscribed_association"),
    NAMED(XCAFDimTolObjects_DimensionModif, MinimumCircumscribedAssociation, "minimum_circumscribed_association"),
    NAMED(XCAFDimTolObjects_DimensionModif, CircumferenceDiameter, "circumference_diameter"),
    NAMED(XCAFDimTolObjects_DimensionModif, AreaDiameter, "area_diameter"),
    NAMED(XCAFDimTolObjects_DimensionModif, VolumeDiameter, "volume_diameter"),
    NAMED(XCAFDimTolObjects_DimensionModif, MaximumSize, "maximum_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, MinimumSize, "minimum_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, AverageSize, "average_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, MedianSize, "median_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, MidRangeSize, "mid_range_size"),
    NAMED(XCAFDimTolObjects_DimensionModif, RangeOfSizes, "range_of_sizes"),
    NAMED(XCAFDimTolObjects_DimensionModif, AnyRestrictedPortionOfFeature, "any_restricted_portion"),
    NAMED(XCAFDimTolObjects_DimensionModif, AnyCrossSection, "any_cross_section"),
    NAMED(XCAFDimTolObjects_DimensionModif, SpecificFixedCrossSection, "specific_fixed_cross_section"),
    NAMED(XCAFDimTolObjects_DimensionModif, CommonTolerance, "common_tolerance"),
    NAMED(XCAFDimTolObjects_DimensionModif, FreeStateCondition, "free_state_condition"),
    NAMED(XCAFDimTolObjects_DimensionModif, Between, "between"),
};

const Named<XCAFDimTolObjects_DimensionQualifier> kQualifiers[] = {
    NAMED(XCAFDimTolObjects_DimensionQualifier, Min, "min"),
    NAMED(XCAFDimTolObjects_DimensionQualifier, Max, "max"),
    NAMED(XCAFDimTolObjects_DimensionQualifier, Avg, "avg"),
};

const Named<XCAFDimTolObjects_DimensionFormVariance> kVariances[] = {
    NAMED(XCAFDimTolObjects_DimensionFormVariance, A, "A"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, B, "B"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, C, "C"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, CD, "CD"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, D, "D"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, E, "E"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, EF, "EF"), NAMED(XCAFDimTolObjects_DimensionFormVariance, F, "F"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, FG, "FG"), NAMED(XCAFDimTolObjects_DimensionFormVariance, G, "G"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, H, "H"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, JS, "JS"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, J, "J"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, K, "K"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, M, "M"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, N, "N"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, P, "P"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, R, "R"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, S, "S"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, T, "T"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, U, "U"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, V, "V"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, X, "X"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, Y, "Y"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, Z, "Z"),   NAMED(XCAFDimTolObjects_DimensionFormVariance, ZA, "ZA"),
    NAMED(XCAFDimTolObjects_DimensionFormVariance, ZB, "ZB"), NAMED(XCAFDimTolObjects_DimensionFormVariance, ZC, "ZC"),
};

const Named<XCAFDimTolObjects_DimensionGrade> kGrades[] = {
    NAMED(XCAFDimTolObjects_DimensionGrade, IT01, "IT01"), NAMED(XCAFDimTolObjects_DimensionGrade, IT0, "IT0"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT1, "IT1"),   NAMED(XCAFDimTolObjects_DimensionGrade, IT2, "IT2"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT3, "IT3"),   NAMED(XCAFDimTolObjects_DimensionGrade, IT4, "IT4"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT5, "IT5"),   NAMED(XCAFDimTolObjects_DimensionGrade, IT6, "IT6"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT7, "IT7"),   NAMED(XCAFDimTolObjects_DimensionGrade, IT8, "IT8"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT9, "IT9"),   NAMED(XCAFDimTolObjects_DimensionGrade, IT10, "IT10"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT11, "IT11"), NAMED(XCAFDimTolObjects_DimensionGrade, IT12, "IT12"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT13, "IT13"), NAMED(XCAFDimTolObjects_DimensionGrade, IT14, "IT14"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT15, "IT15"), NAMED(XCAFDimTolObjects_DimensionGrade, IT16, "IT16"),
    NAMED(XCAFDimTolObjects_DimensionGrade, IT17, "IT17"), NAMED(XCAFDimTolObjects_DimensionGrade, IT18, "IT18"),
};

template <typename E, size_t N>
const char *name_of(const Named<E> (&table)[N], E value) {
  for (const Named<E> &entry : table)
    if (entry.value == value) return entry.name;
  return nullptr;
}

template <typename E, size_t N>
E value_of(const Named<E> (&table)[N], const std::string &name, const char *what) {
  for (const Named<E> &entry : table)
    if (name == entry.name) return entry.value;
  throw std::invalid_argument(std::string("pmi: unknown ") + what + " '" + name + "'");
}

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
    for (const XdePmiAttr &attr : datum.attrs) {
      if (attr.key == "modifier") object->AddModifier(value_of(kDatumModifiers, attr.text, "datum modifier"));
      else if (attr.key == "modifier_with_value")
        throw std::invalid_argument("pmi: a datum modifier with a value is read but not written by this STEP writer");
      else throw std::invalid_argument("pmi: unknown datum attribute '" + attr.key + "'");
    }
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
    for (const XdePmiAttr &attr : tolerance.attrs) {
      if (attr.key == "material_requirement") object->SetMaterialRequirementModifier(value_of(kMaterialRequirements, attr.text, "material requirement"));
      else if (attr.key == "zone_modifier") {
        // OCC 7.9.2 writes the runout zone only: a projected / non-uniform zone would vanish from the file silently
        const auto zone = value_of(kZoneModifiers, attr.text, "zone modifier");
        if (zone != XCAFDimTolObjects_GeomToleranceZoneModif_Runout)
          throw std::invalid_argument("pmi: the zone modifier '" + attr.text + "' is not written by this STEP writer (only 'runout')");
        object->SetZoneModifier(zone);
      }
      else if (attr.key == "zone_modifier_value") object->SetValueOfZoneModifier(attr.number);
      else if (attr.key == "modifier") {
        // the material requirements travel as the material condition (OCC folds them in and out of the modifier list)
        const auto modifier = value_of(kToleranceModifiers, attr.text, "tolerance modifier");
        if (modifier == XCAFDimTolObjects_GeomToleranceModif_Maximum_Material_Requirement)
          object->SetMaterialRequirementModifier(XCAFDimTolObjects_GeomToleranceMatReqModif_M);
        else if (modifier == XCAFDimTolObjects_GeomToleranceModif_Least_Material_Requirement)
          object->SetMaterialRequirementModifier(XCAFDimTolObjects_GeomToleranceMatReqModif_L);
        else if (modifier == XCAFDimTolObjects_GeomToleranceModif_All_Around || modifier == XCAFDimTolObjects_GeomToleranceModif_All_Over)
          throw std::invalid_argument("pmi: '" + attr.text + "' is not written by this STEP writer (it is read-only)");
        else
          object->AddModifier(modifier);
      } else if (attr.key == "max_value")
        throw std::invalid_argument("pmi: a maximum tolerance value is not carried by this STEP writer");
      else if (attr.key == "spherical_zone") object->SetTypeOfValue(XCAFDimTolObjects_GeomToleranceTypeValue_SphericalDiameter);
      else throw std::invalid_argument("pmi: unknown tolerance attribute '" + attr.key + "'");
    }
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
    bool has_range = false, hole = false, has_class = false;
    double lower = 0, upper = 0;
    std::string variance, grade;
    for (const XdePmiAttr &attr : dimension.attrs) {
      if (attr.key == "qualifier") throw std::invalid_argument("pmi: a dimension qualifier is read but not written by this STEP writer");
      else if (attr.key == "modifier") {
        const auto modifier = value_of(kDimensionModifiers, attr.text, "dimension modifier");
        if (modifier == XCAFDimTolObjects_DimensionModif_Between) throw std::invalid_argument("pmi: 'between' is read but not written by this STEP writer");
        object->AddModifier(modifier);
      }
      else if (attr.key == "range_lower") lower = attr.number, has_range = true;
      else if (attr.key == "range_upper") upper = attr.number, has_range = true;
      else if (attr.key == "class_hole") hole = attr.text == "true", has_class = true;
      else if (attr.key == "class_variance") variance = attr.text, has_class = true;
      else if (attr.key == "class_grade") grade = attr.text, has_class = true;
      else throw std::invalid_argument("pmi: unknown dimension attribute '" + attr.key + "'");
    }
    if (has_range) {
      object->SetLowerBound(lower);
      object->SetUpperBound(upper);
    }
    if (has_class) {
      // OCC 7.9.2 writes the grade as (enum + 1) but reads it as (string + 1): a written grade is shifted so the FILE carries the IT number asked for
      // (IT01 as "01", IT2..IT18 as "2".."18"; IT0 and IT1 cannot be written: their strings collide with IT01)
      const auto wanted = value_of(kGrades, grade, "grade");
      if (wanted == XCAFDimTolObjects_DimensionGrade_IT0 || wanted == XCAFDimTolObjects_DimensionGrade_IT1)
        throw std::invalid_argument("pmi: the grade '" + grade + "' cannot be written by this STEP writer");
      const auto stored = wanted == XCAFDimTolObjects_DimensionGrade_IT01 ? wanted : static_cast<XCAFDimTolObjects_DimensionGrade>(static_cast<int>(wanted) - 2);
      object->SetClassOfTolerance(hole, value_of(kVariances, variance, "form variance"), stored);
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

// `"<key>":[ "a", "b" ]` for the names of a modifier sequence (unknown values are skipped: the enumeration is closed in the vocabulary).
template <typename E, size_t N, typename Sequence>
void write_names(JsonWriter &out, const char *key, const Named<E> (&table)[N], const Sequence &values) {
  if (values.Length() == 0) return;
  out.key(key).begin_array();
  for (Standard_Integer i = 1; i <= values.Length(); ++i)
    if (const char *name = name_of(table, values.Value(i))) out.string(name);
  out.end_array();
}

// One datum label as read: the datum may be repeated by the reader (once per tolerance that refers to it, once per datum target).
struct DatumRead {
  std::string label_entry;
  std::string name;
  int owner = -1;
  std::vector<int> faces;
  int off_face_refs = 0;  // features the file names that are not faces (datum targets: points, lines, areas)
  std::vector<std::string> modifiers;
  std::string with_value;
  double with_value_number = 0;
};

// One geometric tolerance, from XCAF (with its modifiers) or straight from the STEP entities (basic attributes only).
struct ToleranceRead {
  std::string characteristic;
  double value = 0;
  bool diameter_zone = false;
  bool spherical_zone = false;
  std::vector<int> faces;
  std::vector<std::string> datums;
  std::string material_requirement, zone_modifier;
  double zone_modifier_value = 0, max_value = 0;
  std::vector<std::string> modifiers;
  int paired_by = 0;  // bit 1: the STEP-entity pass paired a tolerance with this one; bit 2: the text pass did
};

struct DatumGroup {
  std::set<int> faces;
  std::vector<std::string> modifiers;
  std::string with_value;
  double with_value_number = 0;
  int off_face = 0;
};

// ---- the STEP side: tolerances and datum features the XCAF reader leaves out ------------------------------------------------------------
// XCAF binds a tolerance to faces only through sub-shape labels it created; a tolerance whose faces carry none (typically a position tolerance
// with modifiers on an unnamed feature) is dropped. The STEP entities still name the faces: this pass follows the same links as
// STEPCAFControl_Reader (tolerance -> shape aspect -> geometric item usage -> ADVANCED_FACE -> transferred shape) without needing the label.

struct StepSide {
  Handle(Transfer_TransientProcess) process;
  Handle(StepData_StepModel) model;
  std::vector<std::pair<int, TopTools_IndexedMapOfShape>> faces;  // per product: its faces in port order

  bool locate(const TopoDS_Shape &face, int &product, int &index) const {
    for (const auto &entry : faces) {
      const int found = entry.second.FindIndex(face);
      if (found > 0) {
        product = entry.first;
        index = found - 1;
        return true;
      }
    }
    return false;
  }

  TopoDS_Shape shape_of(const Handle(Standard_Transient) &entity) const {
    Standard_Integer index = process->MapIndex(entity);
    if (index <= 0 && !entity.IsNull()) {
      // a geometric item: its topological item
      Interface_EntityIterator sharing = process->Graph().Sharings(entity);
      for (sharing.Start(); sharing.More() && index <= 0; sharing.Next())
        if (sharing.Value()->IsKind(STANDARD_TYPE(StepShape_TopologicalRepresentationItem))) index = process->MapIndex(sharing.Value());
    }
    if (index <= 0) return TopoDS_Shape();
    return TransferBRep::ShapeResult(process->MapItem(index));
  }

  // The shape aspects a tolerance or datum feature stands for (derived aspects, composites and datum features are followed like OCC does).
  void collect(const Handle(StepRepr_ShapeAspect) &aspect, std::vector<Handle(StepRepr_ShapeAspect)> &out, int depth = 0) const {
    if (aspect.IsNull() || depth > 8) return;
    if (aspect->IsKind(STANDARD_TYPE(StepRepr_DerivedShapeAspect))) {
      Interface_EntityIterator sharing = process->Graph().Sharings(aspect);
      for (sharing.Start(); sharing.More(); sharing.Next()) {
        const auto deriving = Handle(StepRepr_ShapeAspectDerivingRelationship)::DownCast(sharing.Value());
        if (!deriving.IsNull()) {
          collect(deriving->RelatedShapeAspect(), out, depth + 1);
          return;
        }
      }
      return;
    }
    if (aspect->IsKind(STANDARD_TYPE(StepDimTol_DatumFeature)) || aspect->IsKind(STANDARD_TYPE(StepDimTol_DatumTarget))) {
      out.push_back(aspect);
      return;
    }
    bool simple = true;
    Interface_EntityIterator sharing = process->Graph().Sharings(aspect);
    for (sharing.Start(); sharing.More(); sharing.Next()) {
      const auto relation = Handle(StepRepr_ShapeAspectRelationship)::DownCast(sharing.Value());
      if (relation.IsNull() || relation->IsKind(STANDARD_TYPE(StepShape_DimensionalLocation))) continue;
      if (relation->RelatingShapeAspect() == aspect && !relation->RelatedShapeAspect().IsNull() &&
          !relation->RelatedShapeAspect()->IsKind(STANDARD_TYPE(StepDimTol_Datum))) {
        collect(relation->RelatedShapeAspect(), out, depth + 1);
        simple = false;
      }
    }
    if (simple) out.push_back(aspect);
  }

  // Faces (product, index) the aspects identify, through their item usages and the aspects they derive from (a centre of symmetry derives from the
  // surfaces it is the centre of); `off_face` counts identified items that are not faces.
  void faces_of(const std::vector<Handle(StepRepr_ShapeAspect)> &aspects, int &owner, std::vector<int> &indices, int *off_face = nullptr,
                int depth = 0) const {
    if (depth > 6) return;
    for (const auto &aspect : aspects) {
      if (aspect.IsNull() || aspect->IsKind(STANDARD_TYPE(StepDimTol_DatumTarget))) continue;
      Interface_EntityIterator sharing = process->Graph().Sharings(aspect);
      for (sharing.Start(); sharing.More(); sharing.Next()) {
        if (const auto deriving = Handle(StepRepr_ShapeAspectDerivingRelationship)::DownCast(sharing.Value());
            !deriving.IsNull() && deriving->RelatingShapeAspect() == aspect && !deriving->RelatedShapeAspect().IsNull()) {
          std::vector<Handle(StepRepr_ShapeAspect)> derived;
          collect(deriving->RelatedShapeAspect(), derived);
          faces_of(derived, owner, indices, off_face, depth + 1);
          continue;
        }
        const auto usage = Handle(StepAP242_ItemIdentifiedRepresentationUsage)::DownCast(sharing.Value());
        if (usage.IsNull()) continue;
        for (Standard_Integer j = 1; j <= usage->NbIdentifiedItem(); ++j) {
          const TopoDS_Shape shape = shape_of(usage->IdentifiedItemValue(j));
          if (shape.IsNull()) continue;
          int product = -1, index = -1;
          if (shape.ShapeType() != TopAbs_FACE || !locate(shape, product, index)) {
            if (off_face != nullptr) ++*off_face;
            continue;
          }
          if (owner < 0) owner = product;
          if (owner == product) indices.push_back(index);
        }
      }
    }
  }
};

// Length unit of a STEP named unit in millimetres (SI prefix, or conversion factor times its own unit); 1 when it cannot be told.
double length_factor_mm(const Handle(StepBasic_NamedUnit) &unit, int depth = 0) {
  if (unit.IsNull() || depth > 3) return 1.0;
  if (const auto si = Handle(StepBasic_SiUnitAndLengthUnit)::DownCast(unit); !si.IsNull()) {
    if (!si->HasPrefix()) return 1000.0;
    switch (si->Prefix()) {
      case StepBasic_spMilli: return 1.0;
      case StepBasic_spCenti: return 10.0;
      case StepBasic_spMicro: return 1e-3;
      case StepBasic_spKilo: return 1e6;
      default: return 1.0;
    }
  }
  if (const auto conversion = Handle(StepBasic_ConversionBasedUnitAndLengthUnit)::DownCast(unit); !conversion.IsNull()) {
    const auto factor = Handle(StepBasic_MeasureWithUnit)::DownCast(conversion->ConversionFactor());
    if (factor.IsNull()) return 1.0;
    return factor->ValueComponent() * length_factor_mm(factor->UnitComponent().NamedUnit(), depth + 1);
  }
  return 1.0;
}

bool tolerance_name(const Handle(Standard_Transient) &entity, const char *&name) {
  XCAFDimTolObjects_GeomToleranceType type = XCAFDimTolObjects_GeomToleranceType_None;
  if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthDatRef)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMaxTol)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMod)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthMaxTol)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthMod)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (const auto e = Handle(StepDimTol_GeoTolAndGeoTolWthDatRefAndUneqDisGeoTol)::DownCast(entity); !e.IsNull())
    type = STEPCAFControl_GDTProperty::GetGeomToleranceType(e->GetToleranceType());
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_AngularityTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Angularity;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_CircularRunoutTolerance))) type = XCAFDimTolObjects_GeomToleranceType_CircularRunout;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_RoundnessTolerance))) type = XCAFDimTolObjects_GeomToleranceType_CircularityOrRoundness;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_CoaxialityTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Coaxiality;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_ConcentricityTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Concentricity;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_CylindricityTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Cylindricity;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_FlatnessTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Flatness;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_ParallelismTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Parallelism;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_PerpendicularityTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Perpendicularity;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_PositionTolerance)) ||
           entity->IsKind(STANDARD_TYPE(StepDimTol_GeoTolAndGeoTolWthDatRefAndModGeoTolAndPosTol)))
    type = XCAFDimTolObjects_GeomToleranceType_Position;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_LineProfileTolerance))) type = XCAFDimTolObjects_GeomToleranceType_ProfileOfLine;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_SurfaceProfileTolerance))) type = XCAFDimTolObjects_GeomToleranceType_ProfileOfSurface;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_StraightnessTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Straightness;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_SymmetryTolerance))) type = XCAFDimTolObjects_GeomToleranceType_Symmetry;
  else if (entity->IsKind(STANDARD_TYPE(StepDimTol_TotalRunoutTolerance))) type = XCAFDimTolObjects_GeomToleranceType_TotalRunout;
  for (const Characteristic &entry : kCharacteristics)
    if (entry.type == type) {
      name = entry.name;
      return true;
    }
  return false;
}

// The datum identifications a tolerance refers to, in reference order (datum system -> compartments -> datums).
std::vector<std::string> datums_of_tolerance(const StepSide &side, const Handle(StepDimTol_GeometricTolerance) &tolerance) {
  std::vector<std::string> names;
  const Interface_Graph &graph = side.process->Graph();
  Interface_EntityIterator shared = graph.Shareds(tolerance);
  for (shared.Start(); shared.More(); shared.Next()) {
    const auto system = Handle(StepDimTol_DatumSystem)::DownCast(shared.Value());
    if (system.IsNull() || system->NbConstituents() == 0) continue;
    const auto compartments = system->Constituents();
    for (Standard_Integer i = compartments->Lower(); i <= compartments->Upper(); ++i) {
      Interface_EntityIterator inside = graph.Shareds(compartments->Value(i));
      for (inside.Start(); inside.More(); inside.Next()) {
        std::vector<Handle(StepDimTol_Datum)> found;
        if (const auto datum = Handle(StepDimTol_Datum)::DownCast(inside.Value()); !datum.IsNull()) found.push_back(datum);
        else if (const auto element = Handle(StepDimTol_DatumReferenceElement)::DownCast(inside.Value()); !element.IsNull()) {
          Interface_EntityIterator members = graph.Shareds(element);
          for (members.Start(); members.More(); members.Next())
            if (const auto member = Handle(StepDimTol_Datum)::DownCast(members.Value()); !member.IsNull()) found.push_back(member);
        }
        for (const auto &datum : found)
          if (!datum->Identification().IsNull()) names.emplace_back(datum->Identification()->ToCString());
      }
    }
  }
  return names;
}


}  // namespace

// One JSON object per product index holding that product's PMI (absent entries = none); `shape_of[index]` numbers the faces. `session` (may be
// null) is the STEP side of the reader: tolerances and datum features XCAF could not bind to faces are recovered from the STEP entities.
std::map<int, std::string> read_pmi(const Handle(XCAFDoc_DimTolTool) & tool, const std::map<std::string, int> &products,
                                    const std::map<int, TopoDS_Shape> &shape_of, const Handle(XSControl_WorkSession) & session, const std::string &content,
                                    int &unmapped) {
  struct Collected {
    std::vector<ToleranceRead> tolerances;
    std::map<std::string, DatumGroup> datums;
    JsonWriter dimensions;
    Collected() { dimensions.begin_array(); }
  };
  std::map<int, Collected> collected;
  const auto faces_of = [&](const TDF_LabelSequence &labels, int &owner, std::vector<int> &indices, int *off_face = nullptr) {
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
      if (index < 0) {
        // a datum target (point, line, area) or an edge: only a datum keeps the product it lies on
        if (off_face != nullptr) {
          ++*off_face;
          if (owner < 0) owner = product;
        }
        continue;
      }
      if (owner < 0) owner = product;
      if (owner == product) indices.push_back(index);
    }
  };

  // 1. every datum label, with its name, faces and modifiers
  TDF_LabelSequence datum_labels;
  tool->GetDatumLabels(datum_labels);
  std::vector<DatumRead> datums;
  std::map<std::string, std::string> datum_name;
  for (Standard_Integer i = 1; i <= datum_labels.Length(); ++i) {
    const TDF_Label label = datum_labels.Value(i);
    Handle(XCAFDoc_Datum) attribute;
    if (!label.FindAttribute(XCAFDoc_Datum::GetID(), attribute)) continue;
    const Handle(XCAFDimTolObjects_DatumObject) object = attribute->GetObject();
    DatumRead read;
    read.label_entry = entry_of(label);
    read.name = object.IsNull() || object->GetName().IsNull() ? "" : object->GetName()->ToCString();
    if (read.name.empty() && !attribute->GetName().IsNull()) read.name = attribute->GetName()->ToCString();
    datum_name[read.label_entry] = read.name;
    TDF_LabelSequence first, second;
    XCAFDoc_DimTolTool::GetRefShapeLabel(label, first, second);
    faces_of(first, read.owner, read.faces, &read.off_face_refs);
    if (!object.IsNull()) {
      const XCAFDimTolObjects_DatumModifiersSequence modifiers = object->GetModifiers();
      for (Standard_Integer k = 1; k <= modifiers.Length(); ++k)
        if (const char *name = name_of(kDatumModifiers, modifiers.Value(k))) read.modifiers.push_back(name);
      XCAFDimTolObjects_DatumModifWithValue with_value = XCAFDimTolObjects_DatumModifWithValue_None;
      object->GetModifierWithValue(with_value, read.with_value_number);
      if (const char *name = name_of(kDatumWithValue, with_value)) read.with_value = name;
    }
    datums.push_back(std::move(read));
  }

  // 2. tolerances (they also tell which product a face-less datum belongs to)
  std::map<std::string, int> owner_by_datum_entry;
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
    TDF_LabelSequence referred;
    XCAFDoc_DimTolTool::GetDatumOfTolerLabels(label, referred);
    for (Standard_Integer k = 1; k <= referred.Length(); ++k) owner_by_datum_entry.emplace(entry_of(referred.Value(k)), owner);
    ToleranceRead read;
    read.characteristic = characteristic;
    read.value = object->GetValue();
    const XCAFDimTolObjects_GeomToleranceTypeValue zone = object->GetTypeOfValue();
    read.diameter_zone = zone == XCAFDimTolObjects_GeomToleranceTypeValue_Diameter;
    read.spherical_zone = zone == XCAFDimTolObjects_GeomToleranceTypeValue_SphericalDiameter;
    read.faces = indices;
    // XCAF lists one datum label per datum target as well: a datum is named once, in reference order
    for (Standard_Integer k = 1; k <= referred.Length(); ++k) {
      const std::string &name = datum_name[entry_of(referred.Value(k))];
      if (std::find(read.datums.begin(), read.datums.end(), name) == read.datums.end()) read.datums.push_back(name);
    }
    if (const char *name = name_of(kMaterialRequirements, object->GetMaterialRequirementModifier())) read.material_requirement = name;
    if (const char *name = name_of(kZoneModifiers, object->GetZoneModifier())) {
      read.zone_modifier = name;
      read.zone_modifier_value = object->GetValueOfZoneModifier();
    }
    const XCAFDimTolObjects_GeomToleranceModifiersSequence modifiers = object->GetModifiers();
    for (Standard_Integer k = 1; k <= modifiers.Length(); ++k)
      if (const char *name = name_of(kToleranceModifiers, modifiers.Value(k))) read.modifiers.push_back(name);
    read.max_value = object->GetMaxValueModifier();
    collected[owner].tolerances.push_back(std::move(read));
  }

  // Tolerances read from the STEP side (entities, then text) are paired with the XCAF ones of the same product, characteristic and datums, exact
  // values first: XCAF reports 0 for a magnitude it cannot type and a wrongly scaled value for some modified tolerances, the text is authoritative.
  // A STEP-side tolerance with no partner is one XCAF dropped. Partners on the same faces come first (phases 0-1): a part with several
  // profiles against the same datums would otherwise pair by XCAF's label order, which differs between builds (stc_07: MinGW vs MSVC).
  std::vector<std::pair<int, ToleranceRead>> from_entities, from_text;
  const auto same_faces = [](const ToleranceRead &a, const ToleranceRead &b) {
    if (a.faces.empty() || b.faces.empty()) return false;
    std::vector<int> left = a.faces, right = b.faces;
    std::sort(left.begin(), left.end());
    std::sort(right.begin(), right.end());
    return left == right;
  };
  const auto reconcile = [&](std::vector<std::pair<int, ToleranceRead>> &incoming, int pass) {
    std::vector<bool> placed(incoming.size(), false);
    for (int phase = 0; phase < 4; ++phase) {
      for (size_t k = 0; k < incoming.size(); ++k) {
        if (placed[k]) continue;
        const int owner = incoming[k].first;
        const ToleranceRead &read = incoming[k].second;
        for (ToleranceRead &existing : collected[owner].tolerances) {
          if ((existing.paired_by & pass) != 0 || existing.characteristic != read.characteristic) continue;
          if (phase < 2 && !same_faces(existing, read)) continue;
          if (existing.datums != read.datums && !(pass == 2 && read.datums.empty())) continue;
          const bool equal = std::fabs(existing.value - read.value) <= 1e-9 * std::max(1.0, std::fabs(read.value));
          if (phase % 2 == 0 && !equal && existing.value != 0 && read.value != 0) continue;
          if (existing.value == 0 || (pass == 2 && read.value != 0)) existing.value = read.value;
          existing.paired_by |= pass;
          placed[k] = true;
          break;
        }
      }
    }
    for (size_t k = 0; k < incoming.size(); ++k) {
      if (placed[k]) continue;
      incoming[k].second.paired_by = pass;
      collected[incoming[k].first].tolerances.push_back(std::move(incoming[k].second));
    }
  };

  // 3. the STEP entities the XCAF reader dropped: tolerances and datum features bound to faces by the transferred shapes
  if (!session.IsNull()) {
    StepSide side;
    side.process = session->TransferReader()->TransientProcess();
    side.model = Handle(StepData_StepModel)::DownCast(session->Model());
    for (const auto &entry : shape_of) {
      TopTools_IndexedMapOfShape map;
      TopExp::MapShapes(entry.second, TopAbs_FACE, map);
      side.faces.emplace_back(entry.first, std::move(map));
    }
    if (!side.process.IsNull() && !side.model.IsNull()) {
      for (Standard_Integer i = 1; i <= side.model->NbEntities(); ++i) {
        const Handle(Standard_Transient) entity = side.model->Value(i);
        if (const auto tolerance = Handle(StepDimTol_GeometricTolerance)::DownCast(entity); !tolerance.IsNull()) {
          const char *characteristic = nullptr;
          if (!tolerance_name(entity, characteristic)) continue;
          std::vector<Handle(StepRepr_ShapeAspect)> aspects;
          Interface_EntityIterator shared = side.process->Graph().Shareds(tolerance);
          for (shared.Start(); shared.More(); shared.Next()) {
            if (const auto aspect = Handle(StepRepr_ShapeAspect)::DownCast(shared.Value()); !aspect.IsNull()) side.collect(aspect, aspects);
            else if (shared.Value()->IsKind(STANDARD_TYPE(StepShape_DimensionalLocation)) ||
                     shared.Value()->IsKind(STANDARD_TYPE(StepShape_DimensionalSize))) {
              Interface_EntityIterator inside = side.process->Graph().Shareds(shared.Value());
              for (inside.Start(); inside.More(); inside.Next())
                if (const auto aspect = Handle(StepRepr_ShapeAspect)::DownCast(inside.Value()); !aspect.IsNull()) side.collect(aspect, aspects);
            }
          }
          int owner = -1;
          std::vector<int> indices;
          side.faces_of(aspects, owner, indices);
          if (owner < 0) continue;
          ToleranceRead read;
          read.characteristic = characteristic;
          // an untyped magnitude (a complex record) comes back null: 0 here, the text pass below supplies it
          if (!tolerance->Magnitude().IsNull())
            read.value = tolerance->Magnitude()->ValueComponent() * length_factor_mm(tolerance->Magnitude()->UnitComponent().NamedUnit());
          read.faces = indices;
          read.datums = datums_of_tolerance(side, tolerance);
          Interface_EntityIterator sharing = side.process->Graph().Sharings(tolerance);
          for (sharing.Start(); sharing.More(); sharing.Next()) {
            const auto zone = Handle(StepDimTol_ToleranceZone)::DownCast(sharing.Value());
            if (zone.IsNull() || zone->Form().IsNull()) continue;
            XCAFDimTolObjects_GeomToleranceTypeValue kind = XCAFDimTolObjects_GeomToleranceTypeValue_None;
            STEPCAFControl_GDTProperty::GetTolValueType(zone->Form()->Name(), kind);
            read.diameter_zone = kind == XCAFDimTolObjects_GeomToleranceTypeValue_Diameter;
            read.spherical_zone = kind == XCAFDimTolObjects_GeomToleranceTypeValue_SphericalDiameter;
          }
          from_entities.emplace_back(owner, std::move(read));
        } else if (const auto datum = Handle(StepDimTol_Datum)::DownCast(entity); !datum.IsNull() && !datum->Identification().IsNull()) {
          // the datum features of a datum: the faces their shape aspects identify
          std::vector<Handle(StepRepr_ShapeAspect)> aspects;
          Interface_EntityIterator sharing = side.process->Graph().Sharings(datum);
          for (sharing.Start(); sharing.More(); sharing.Next())
            if (const auto relation = Handle(StepRepr_ShapeAspectRelationship)::DownCast(sharing.Value()); !relation.IsNull())
              side.collect(relation->RelatingShapeAspect(), aspects);
          int owner = -1;
          std::vector<int> indices;
          int off_face = 0;
          side.faces_of(aspects, owner, indices, &off_face);
          if (owner < 0 || indices.empty()) continue;
          DatumGroup &into = collected[owner].datums[datum->Identification()->ToCString()];
          into.faces.insert(indices.begin(), indices.end());
        }
      }
    }
  }

  reconcile(from_entities, 1);

  // 3b. the Part 21 text: datum features and tolerances whose links the OCC classes do not expose
  if (!session.IsNull() && !content.empty()) {
    StepSide side;
    side.process = session->TransferReader()->TransientProcess();
    side.model = Handle(StepData_StepModel)::DownCast(session->Model());
    for (const auto &entry : shape_of) {
      TopTools_IndexedMapOfShape map;
      TopExp::MapShapes(entry.second, TopAbs_FACE, map);
      side.faces.emplace_back(entry.first, std::move(map));
    }
    if (!side.process.IsNull() && !side.model.IsNull()) {
      const pmi_text::Records records(content);
      const pmi_text::Graph graph(records);
      std::unordered_map<long, Handle(Standard_Transient)> entity_of;
      for (Standard_Integer i = 1; i <= side.model->NbEntities(); ++i) entity_of[side.model->IdentLabel(side.model->Value(i))] = side.model->Value(i);
      // the faces (product, index) the items identify
      const auto faces_of_items = [&](const std::set<long> &items, int &owner, std::vector<int> &indices, int *off_face) {
        for (const long item : items) {
          const auto found = entity_of.find(item);
          if (found == entity_of.end()) continue;
          const TopoDS_Shape shape = side.shape_of(found->second);
          if (shape.IsNull()) continue;
          int product = -1, index = -1;
          if (shape.ShapeType() != TopAbs_FACE || !side.locate(shape, product, index)) {
            if (off_face != nullptr) ++*off_face;
            continue;
          }
          if (owner < 0) owner = product;
          if (owner == product) indices.push_back(index);
        }
      };
      static const char *const kNames[][2] = {
          {"FLATNESS_TOLERANCE", "flatness"},           {"POSITION_TOLERANCE", "position"},         {"PERPENDICULARITY_TOLERANCE", "perpendicularity"},
          {"PARALLELISM_TOLERANCE", "parallelism"},     {"SURFACE_PROFILE_TOLERANCE", "profile_surface"}, {"LINE_PROFILE_TOLERANCE", "profile_line"},
          {"CYLINDRICITY_TOLERANCE", "cylindricity"},   {"ROUNDNESS_TOLERANCE", "circularity"},     {"STRAIGHTNESS_TOLERANCE", "straightness"},
          {"SYMMETRY_TOLERANCE", "symmetry"},           {"CONCENTRICITY_TOLERANCE", "concentricity"}, {"COAXIALITY_TOLERANCE", "coaxiality"},
          {"ANGULARITY_TOLERANCE", "angularity"},       {"CIRCULAR_RUNOUT_TOLERANCE", "circular_runout"}, {"TOTAL_RUNOUT_TOLERANCE", "total_runout"},
      };
      for (const auto &entry : records.all()) {
        const std::string &record = entry.second;
        if (pmi_text::has_entity(record, "DATUM")) {
          // a datum: the faces its datum features (the aspects related to it) identify
          const std::string name = pmi_text::last_string(record);
          std::set<long> items, seen;
          if (const auto features = graph.relating_of.find(entry.first); features != graph.relating_of.end())
            for (const long feature : features->second) graph.items_of(feature, items, seen);
          int owner = -1, off_face = 0;
          std::vector<int> indices;
          faces_of_items(items, owner, indices, &off_face);
          if (owner >= 0 && !indices.empty() && !name.empty()) collected[owner].datums[name].faces.insert(indices.begin(), indices.end());
          continue;
        }
        if (!pmi_text::has_entity(record, "GEOMETRIC_TOLERANCE") && !pmi_text::has_entity(record, "FLATNESS_TOLERANCE") &&
            !pmi_text::has_entity(record, "POSITION_TOLERANCE") && !pmi_text::has_entity(record, "PERPENDICULARITY_TOLERANCE") &&
            !pmi_text::has_entity(record, "PARALLELISM_TOLERANCE") && !pmi_text::has_entity(record, "SURFACE_PROFILE_TOLERANCE") &&
            !pmi_text::has_entity(record, "LINE_PROFILE_TOLERANCE") && !pmi_text::has_entity(record, "CYLINDRICITY_TOLERANCE") &&
            !pmi_text::has_entity(record, "ROUNDNESS_TOLERANCE") && !pmi_text::has_entity(record, "STRAIGHTNESS_TOLERANCE") &&
            !pmi_text::has_entity(record, "SYMMETRY_TOLERANCE") && !pmi_text::has_entity(record, "CONCENTRICITY_TOLERANCE") &&
            !pmi_text::has_entity(record, "COAXIALITY_TOLERANCE") && !pmi_text::has_entity(record, "ANGULARITY_TOLERANCE") &&
            !pmi_text::has_entity(record, "CIRCULAR_RUNOUT_TOLERANCE") && !pmi_text::has_entity(record, "TOTAL_RUNOUT_TOLERANCE"))
          continue;
        const char *characteristic = nullptr;
        for (const auto &names : kNames)
          if (pmi_text::has_entity(record, names[0])) characteristic = names[1];
        if (characteristic == nullptr) continue;
        // GEOMETRIC_TOLERANCE('name','',#magnitude,#aspect) - on its own (a complex record) or the entity's own arguments
        std::vector<long> arguments = pmi_text::arguments_of(record, "GEOMETRIC_TOLERANCE");
        bool own_arguments = false;
        if (arguments.size() < 2) {
          own_arguments = true;
          for (const auto &names : kNames)
            if (pmi_text::has_entity(record, names[0]) && arguments.size() < 2) arguments = pmi_text::arguments_of(record, names[0]);
        }
        if (arguments.size() < 2) continue;
        ToleranceRead read;
        read.characteristic = characteristic;
        pmi_text::length_mm(records, arguments[0], read.value);
        // datums: system -> compartments / elements -> DATUM records, in order
        std::set<long> visited;
        const std::function<void(long, int)> collect_datums = [&](long id, int depth) {
          if (depth > 5 || !visited.insert(id).second) return;
          const std::string &part = records.get(id);
          if (pmi_text::has_entity(part, "DATUM")) {
            const std::string name = pmi_text::last_string(part);
            if (!name.empty() && std::find(read.datums.begin(), read.datums.end(), name) == read.datums.end()) read.datums.push_back(name);
            return;
          }
          for (const long next : pmi_text::references(part)) collect_datums(next, depth + 1);
        };
        // a complex record keeps its datum reference in GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((#system)); the entity's own form lists it after the aspect
        if (own_arguments) {
          for (size_t k = 2; k < arguments.size(); ++k) collect_datums(arguments[k], 0);
        } else {
          for (const long system : pmi_text::arguments_of(record, "GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE")) collect_datums(system, 0);
        }
        std::set<long> items, seen;
        graph.items_of(arguments[1], items, seen);
        int owner = -1;
        faces_of_items(items, owner, read.faces, nullptr);
        if (owner < 0) continue;
        from_text.emplace_back(owner, std::move(read));
      }
    }
  }

  reconcile(from_text, 2);

  // 4. datums, one entry per (product, name): the faces of every repetition united (the writer repeats a datum for every tolerance that refers
  // to it); a datum no face of a product carries (its features are datum targets or edges) is counted unmapped
  int fallback = -1;
  for (const auto &entry : shape_of)
    if (fallback < 0) fallback = entry.first;
  for (const DatumRead &read : datums) {
    int owner = read.owner;
    if (owner < 0) {
      const auto used = owner_by_datum_entry.find(read.label_entry);
      owner = used != owner_by_datum_entry.end() ? used->second : fallback;
    }
    if (owner < 0) {
      ++unmapped;
      continue;
    }
    DatumGroup &into = collected[owner].datums[read.name];
    into.faces.insert(read.faces.begin(), read.faces.end());
    for (const std::string &modifier : read.modifiers)
      if (std::find(into.modifiers.begin(), into.modifiers.end(), modifier) == into.modifiers.end()) into.modifiers.push_back(modifier);
    if (into.with_value.empty()) {
      into.with_value = read.with_value;
      into.with_value_number = read.with_value_number;
    }
    into.off_face += read.off_face_refs;
  }

  // 5. dimensions
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
    // dimension presentations and common labels are annotation objects, not dimensions
    const bool annotation = object->GetType() == XCAFDimTolObjects_DimensionType_CommonLabel ||
                            object->GetType() == XCAFDimTolObjects_DimensionType_DimensionPresentation;
    if (kind == nullptr || owner < 0) {
      if (!annotation) ++unmapped;
      continue;
    }
    JsonWriter &out = collected[owner].dimensions;
    out.begin_object().key("type").string(kind->name).key("value").number(object->GetValue());
    if (object->GetUpperTolValue() != 0 || object->GetLowerTolValue() != 0)
      out.key("tolerance").begin_object().key("plus").number(object->GetUpperTolValue()).key("minus").number(object->GetLowerTolValue()).end_object();
    out.key("faces").begin_array();
    for (const int index : indices) out.integer(index);
    out.end_array();
    if (kind->two_sided) {
      out.key("facesSecond").begin_array();
      for (const int index : indices_second) out.integer(index);
      out.end_array();
    }
    if (object->HasQualifier())
      if (const char *name = name_of(kQualifiers, object->GetQualifier())) out.key("qualifier").string(name);
    write_names(out, "modifiers", kDimensionModifiers, object->GetModifiers());
    if (object->IsDimWithRange()) out.key("range").begin_object().key("lower").number(object->GetLowerBound()).key("upper").number(object->GetUpperBound()).end_object();
    Standard_Boolean hole = Standard_False;
    XCAFDimTolObjects_DimensionFormVariance variance = XCAFDimTolObjects_DimensionFormVariance_None;
    XCAFDimTolObjects_DimensionGrade grade = XCAFDimTolObjects_DimensionGrade_IT01;
    if (object->IsDimWithClassOfTolerance() && object->GetClassOfTolerance(hole, variance, grade)) {
      const char *variance_name = name_of(kVariances, variance);
      const char *grade_name = name_of(kGrades, grade);
      if (variance_name != nullptr && grade_name != nullptr)
        out.key("classOfTolerance").begin_object().key("hole").boolean(hole).key("variance").string(variance_name).key("grade").string(grade_name).end_object();
    }
    out.end_object();
  }

  // 6. one JSON object per product
  std::map<int, std::string> result;
  for (auto &entry : collected) {
    Collected &item = entry.second;
    JsonWriter datums_out;
    datums_out.begin_array();
    for (const auto &named : item.datums) {
      if (named.second.faces.empty()) {
        ++unmapped;
        continue;
      }
      datums_out.begin_object().key("label").string(named.first);
      datums_out.key("faces").begin_array();
      for (const int index : named.second.faces) datums_out.integer(index);
      datums_out.end_array();
      if (!named.second.modifiers.empty()) {
        datums_out.key("modifiers").begin_array();
        for (const std::string &modifier : named.second.modifiers) datums_out.string(modifier.c_str());
        datums_out.end_array();
      }
      if (!named.second.with_value.empty())
        datums_out.key("modifierWithValue").begin_object().key("kind").string(named.second.with_value.c_str()).key("value").number(named.second.with_value_number).end_object();
      datums_out.end_object();
    }
    datums_out.end_array();
    JsonWriter tolerances_out;
    tolerances_out.begin_array();
    for (const ToleranceRead &read : item.tolerances) {
      tolerances_out.begin_object().key("characteristic").string(read.characteristic).key("value").number(read.value);
      tolerances_out.key("diameterZone").boolean(read.diameter_zone);
      if (read.spherical_zone) tolerances_out.key("sphericalZone").boolean(true);
      tolerances_out.key("faces").begin_array();
      for (const int index : read.faces) tolerances_out.integer(index);
      tolerances_out.end_array().key("datums").begin_array();
      for (const std::string &name : read.datums) tolerances_out.string(name);
      tolerances_out.end_array();
      if (!read.material_requirement.empty()) tolerances_out.key("materialRequirement").string(read.material_requirement);
      if (!read.zone_modifier.empty()) {
        tolerances_out.key("zoneModifier").string(read.zone_modifier);
        if (read.zone_modifier_value != 0) tolerances_out.key("zoneModifierValue").number(read.zone_modifier_value);
      }
      if (!read.modifiers.empty()) {
        tolerances_out.key("modifiers").begin_array();
        for (const std::string &modifier : read.modifiers) tolerances_out.string(modifier);
        tolerances_out.end_array();
      }
      if (read.max_value != 0) tolerances_out.key("maxValue").number(read.max_value);
      tolerances_out.end_object();
    }
    tolerances_out.end_array();
    item.dimensions.end_array();
    JsonWriter out;
    out.begin_object().key("datums").raw(datums_out.text()).key("tolerances").raw(tolerances_out.text()).key("dimensions").raw(item.dimensions.text());
    out.end_object();
    result[entry.first] = out.text();
  }
  return result;
}

}  // namespace llull

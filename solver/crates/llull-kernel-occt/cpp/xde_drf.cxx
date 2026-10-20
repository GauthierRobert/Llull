// One DATUM_SYSTEM per datum reference frame (03 GD&T VC-GDT-22, NIST SFA "Datum Reference Frames for 'datum_system' should be unique for the
// same product_definition_shape"). OCC 7.9.2's STEPCAFControl_Writer (WriteDatumSystem) builds a fresh DATUM_SYSTEM with its own
// DATUM_REFERENCE_COMPARTMENTs for EVERY geometric tolerance, so two tolerances on A|B|C write two identical frames. After the transfer and before
// the file is written, the identical frames of one product_definition_shape are merged: every tolerance refers to the first, and the duplicates
// (with the compartments, elements and modifier values only they used) leave the model. Readers see the standard shape: one frame, many uses.
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <Interface_EntityIterator.hxx>
#include <Interface_Graph.hxx>
#include <StepData_StepModel.hxx>
#include <StepDimTol_Datum.hxx>
#include <StepDimTol_DatumOrCommonDatum.hxx>
#include <StepDimTol_DatumReferenceCompartment.hxx>
#include <StepDimTol_DatumReferenceElement.hxx>
#include <StepDimTol_DatumReferenceModifier.hxx>
#include <StepDimTol_DatumReferenceModifierWithValue.hxx>
#include <StepDimTol_DatumSystem.hxx>
#include <StepDimTol_DatumSystemOrReference.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRef.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMod.hxx>
#include <StepDimTol_GeoTolAndGeoTolWthDatRefAndModGeoTolAndPosTol.hxx>
#include <StepDimTol_GeometricToleranceWithDatumReference.hxx>
#include <StepDimTol_HArray1OfDatumReferenceCompartment.hxx>
#include <StepDimTol_HArray1OfDatumReferenceElement.hxx>
#include <StepDimTol_HArray1OfDatumReferenceModifier.hxx>
#include <StepDimTol_HArray1OfDatumSystemOrReference.hxx>
#include <StepDimTol_SimpleDatumReferenceModifierMember.hxx>
#include <StepRepr_ProductDefinitionShape.hxx>
#include <TCollection_HAsciiString.hxx>

#include "llull-kernel-occt/cpp/xde.hxx"

namespace llull {

namespace {

template <typename T>
std::string identity(const Handle(T) & entity) {
  return entity.IsNull() ? "0" : std::to_string(reinterpret_cast<std::uintptr_t>(entity.get()));
}

std::string text(const Handle(TCollection_HAsciiString) & value) { return value.IsNull() ? std::string("$") : std::string(value->ToCString()); }

// A simple modifier compares by its enumeration; a modifier with a value by its entity (merged only when it is the same one: conservative).
std::string modifiers_key(const Handle(StepDimTol_HArray1OfDatumReferenceModifier) & modifiers) {
  std::string key = "[";
  if (!modifiers.IsNull())
    for (Standard_Integer i = modifiers->Lower(); i <= modifiers->Upper(); ++i) {
      const StepDimTol_DatumReferenceModifier &modifier = modifiers->Value(i);
      const Handle(StepDimTol_SimpleDatumReferenceModifierMember) simple = modifier.SimpleDatumReferenceModifierMember();
      key += simple.IsNull() ? "v" + identity(modifier.Value()) : "s" + std::to_string(static_cast<int>(simple->Value()));
      key += ",";
    }
  return key + "]";
}

std::string base_key(const StepDimTol_DatumOrCommonDatum &base);

std::string element_key(const Handle(StepDimTol_DatumReferenceElement) & element) {
  if (element.IsNull()) return "0";
  return "e(" + identity(element->OfShape()) + "," + base_key(element->Base()) + "," + modifiers_key(element->Modifiers()) + ")";
}

std::string base_key(const StepDimTol_DatumOrCommonDatum &base) {
  const Handle(StepDimTol_Datum) datum = base.Datum();
  if (!datum.IsNull()) return "d" + identity(datum);
  const Handle(StepDimTol_HArray1OfDatumReferenceElement) common = base.CommonDatumList();
  if (common.IsNull()) return "?" + identity(base.Value());
  std::string key = "c(";
  for (Standard_Integer i = common->Lower(); i <= common->Upper(); ++i) key += element_key(common->Value(i)) + ";";
  return key + ")";
}

// Same product_definition_shape, same compartments in the same order, each with the same datums and modifiers (and the same names).
std::string frame_key(const Handle(StepDimTol_DatumSystem) & system) {
  std::string key = identity(system->OfShape()) + "|" + text(system->Name()) + "|" + text(system->Description()) + "|" +
                    std::to_string(static_cast<int>(system->ProductDefinitional()));
  const Handle(StepDimTol_HArray1OfDatumReferenceCompartment) constituents = system->Constituents();
  if (constituents.IsNull()) return key;
  for (Standard_Integer i = constituents->Lower(); i <= constituents->Upper(); ++i) {
    const Handle(StepDimTol_DatumReferenceCompartment) compartment = constituents->Value(i);
    if (compartment.IsNull()) return key + "|null" + identity(system);  // never merged
    key += "|" + identity(compartment->OfShape()) + ":" + text(compartment->Name()) + ":" + base_key(compartment->Base()) + ":" +
           modifiers_key(compartment->Modifiers());
  }
  return key;
}

// The AP242 datum_system list of a tolerance (the plain entity or one of OCC's complex instances), or null.
Handle(StepDimTol_HArray1OfDatumSystemOrReference) frames_of(const Handle(Standard_Transient) & entity) {
  Handle(StepDimTol_GeometricToleranceWithDatumReference) with;
  if (const auto plain = Handle(StepDimTol_GeometricToleranceWithDatumReference)::DownCast(entity); !plain.IsNull()) with = plain;
  else if (const auto both = Handle(StepDimTol_GeoTolAndGeoTolWthDatRef)::DownCast(entity); !both.IsNull())
    with = both->GetGeometricToleranceWithDatumReference();
  else if (const auto modified = Handle(StepDimTol_GeoTolAndGeoTolWthDatRefAndGeoTolWthMod)::DownCast(entity); !modified.IsNull())
    with = modified->GetGeometricToleranceWithDatumReference();
  else if (const auto position = Handle(StepDimTol_GeoTolAndGeoTolWthDatRefAndModGeoTolAndPosTol)::DownCast(entity); !position.IsNull())
    with = position->GetGeometricToleranceWithDatumReference();
  return with.IsNull() ? Handle(StepDimTol_HArray1OfDatumSystemOrReference)() : with->DatumSystemAP242();
}

// The duplicate frame and what only it held: its compartments, their common-datum elements and the modifier-with-value records.
void owned_by(const Handle(StepDimTol_DatumSystem) & system, std::vector<Handle(Standard_Transient)> &out) {
  out.push_back(system);
  const auto add_modifiers = [&out](const Handle(StepDimTol_HArray1OfDatumReferenceModifier) & modifiers) {
    if (modifiers.IsNull()) return;
    for (Standard_Integer i = modifiers->Lower(); i <= modifiers->Upper(); ++i)
      if (const auto valued = modifiers->Value(i).DatumReferenceModifierWithValue(); !valued.IsNull()) out.push_back(valued);
  };
  const std::function<void(const StepDimTol_DatumOrCommonDatum &)> add_base = [&](const StepDimTol_DatumOrCommonDatum &base) {
    const Handle(StepDimTol_HArray1OfDatumReferenceElement) common = base.CommonDatumList();
    if (common.IsNull()) return;
    for (Standard_Integer i = common->Lower(); i <= common->Upper(); ++i) {
      const Handle(StepDimTol_DatumReferenceElement) element = common->Value(i);
      if (element.IsNull()) continue;
      out.push_back(element);
      add_base(element->Base());
      add_modifiers(element->Modifiers());
    }
  };
  const Handle(StepDimTol_HArray1OfDatumReferenceCompartment) constituents = system->Constituents();
  if (constituents.IsNull()) return;
  for (Standard_Integer i = constituents->Lower(); i <= constituents->Upper(); ++i) {
    const Handle(StepDimTol_DatumReferenceCompartment) compartment = constituents->Value(i);
    if (compartment.IsNull()) continue;
    out.push_back(compartment);
    add_base(compartment->Base());
    add_modifiers(compartment->Modifiers());
  }
}

}  // namespace

int merge_datum_systems(const Handle(StepData_StepModel) & model) {
  std::map<std::string, Handle(StepDimTol_DatumSystem)> first_of;
  std::map<const Standard_Transient *, Handle(StepDimTol_DatumSystem)> kept_for;
  std::vector<Handle(StepDimTol_DatumSystem)> duplicates;
  for (Standard_Integer i = 1; i <= model->NbEntities(); ++i) {
    const Handle(StepDimTol_DatumSystem) system = Handle(StepDimTol_DatumSystem)::DownCast(model->Value(i));
    if (system.IsNull()) continue;
    const auto [at, inserted] = first_of.emplace(frame_key(system), system);
    if (inserted) continue;
    kept_for[system.get()] = at->second;
    duplicates.push_back(system);
  }
  if (duplicates.empty()) return 0;
  for (Standard_Integer i = 1; i <= model->NbEntities(); ++i) {
    const Handle(StepDimTol_HArray1OfDatumSystemOrReference) frames = frames_of(model->Value(i));
    if (frames.IsNull()) continue;
    for (Standard_Integer k = frames->Lower(); k <= frames->Upper(); ++k) {
      const auto found = kept_for.find(frames->Value(k).DatumSystem().get());
      if (found == kept_for.end()) continue;
      StepDimTol_DatumSystemOrReference kept;
      kept.SetValue(found->second);
      frames->SetValue(k, kept);
    }
  }
  // Drop a duplicate's records only when nothing outside them still refers to one (an entity this pass does not redirect keeps its frame).
  std::vector<Handle(Standard_Transient)> owned;
  for (const Handle(StepDimTol_DatumSystem) &system : duplicates) owned_by(system, owned);
  std::set<const Standard_Transient *> removed;
  for (const Handle(Standard_Transient) &entity : owned) removed.insert(entity.get());
  const Interface_Graph graph(model);
  bool changed = true;
  while (changed) {
    changed = false;
    for (const Handle(Standard_Transient) &entity : owned) {
      if (removed.count(entity.get()) == 0) continue;
      for (Interface_EntityIterator sharing = graph.Sharings(entity); sharing.More(); sharing.Next())
        if (removed.count(sharing.Value().get()) == 0) {
          removed.erase(entity.get());
          changed = true;
          break;
        }
    }
  }
  std::vector<Handle(Standard_Transient)> remaining;
  for (Standard_Integer i = 1; i <= model->NbEntities(); ++i)
    if (removed.count(model->Value(i).get()) == 0) remaining.push_back(model->Value(i));
  const int dropped = model->NbEntities() - static_cast<int>(remaining.size());
  model->ClearEntities();
  for (const Handle(Standard_Transient) &entity : remaining) model->AddEntity(entity);
  return dropped;
}

}  // namespace llull

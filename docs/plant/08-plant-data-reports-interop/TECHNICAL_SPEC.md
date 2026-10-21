# Gap 08 DAT — Plant data, reports and interoperability: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Agent-first
requirements: [../../aerospace/AGENT_FIRST.md](../../aerospace/AGENT_FIRST.md). Validation:
[validation/README.md](validation/README.md).

## 1. Current state in llull (before this gap)

| Area | Where | What exists | Limit for plant data |
| ---- | ----- | ----------- | -------------------- |
| Building / industrial model | `packages/core/src/model/building.ts` (`BuildingModel`, `EquipmentElement`, `PipeElement`, `PipeSupportElement`, `CableTrayElement`, `ProjectInfo`) | Elements with a free-text `mark`; equipment `name`, `size`, `shape`, `clearance`, `weight`; pipe `points`, `diameter`, `service`, `material`, optional `line`, `dn`, `from`, `to` | No class, no typed property bag, no tag format, no hierarchy above levels, `ProjectInfo` is free text |
| Equipment | `packages/domain-aec/src/industrial/equipment/equipment.ts` (`add_equipment`, `add_pipe_run`), `equipmentUpdate.ts` (`update_equipment`) | Explicit equipment marks must be unique among equipment ("line-list from/to references need unique tags"); pipe runs keep line / DN / from / to | Uniqueness is per category only; `from` / `to` are never resolved; no other class has a tag |
| Schedules | `packages/domain-aec/src/building/quantities/scheduleBuild.ts`, `takeoff.ts` (`building_schedule`) | Kinds `equipment` (mark, name, level, x, y, size, clearance, weight, shape) and `pipe` (mark, line, DN, service, diameter, material, length m, bends, from, to, level), `support`, `tray`, … ; `data.csv` (RFC 4180, `packages/domain-aec/src/shared/csv.ts`) | Fixed columns, no XLSX, no per-class properties, no valve / nozzle / instrument lists |
| Quantities | `packages/domain-aec/src/building/quantities/takeoffCompute.ts` (`quantity_takeoff`, `estimate_cost`) | Pipe length by `service Ø diameter`; support counts and rod length | Not grouped by piping spec; no components |
| BOM | `packages/core/src/commands/assembly/billOfMaterials.ts` (`bill_of_materials`) | Instances grouped by component, mass, standard parts | Mechanical assemblies, not plant objects |
| IFC export | `packages/domain-aec/src/building/exchange/ifcBuild.ts` (`export_ifc`), `ifcStep.ts` (STEP writer, `ifcGuid` = FNV-1a 128-bit hash of `<building uid>:<seed>`), `ifcIndustrialExport.ts`, `ifcSupportExport.ts`, `ifcVesselExport.ts` | `FILE_SCHEMA(('IFC4'))`, view *DesignTransferView_V1.0*; Project → Site → Building → Storeys; pipe = one `IfcPipeSegment` `.RIGIDSEGMENT.` per run, one extruded circle per straight, `Name` = mark, `Description` = "line service"; equipment = `IfcBuildingElementProxy` `.ELEMENT.` + `Pset_llullEquipment`; pipe support = proxy `ObjectType 'PIPESUPPORT'` + `Pset_llullPipeSupport`; tray = `IfcCableCarrierSegment` `.CABLETRAYSEGMENT.`; units mm, m², m³, rad; stable GlobalIds | IFC4 only; no `Tag`; no fittings, valves, typed equipment, ports, `IfcRelConnectsPorts`, `IfcDistributionSystem`; no pressure / temperature units |
| IFC oracle | `tests/production/oracle/ifc.ts` (`parseIfc`), `tests/production/criteria/deliverables.ts`, `pipeRack.ts` | Test-side STEP parser; checks schema `IFC4`, unique GlobalIds, counts per class, pipe solids | Test code only; not a command |
| Other exchange | `packages/core/src/commands/exchange/*` (`export_gltf`, `export_stl`, `export_obj`, `import_dxf`, `import_step_exact`), `brep/stepTargets.ts` (`export_step_ap242`), `building/exchange/dxfExport.ts` (`export_building_dxf`) | Geometry exchange | No data exchange (XLSX / CSV import, IDS) |
| Binary helpers | `packages/core/src/lib/deflate.ts` (`deflateRaw`), `png.ts` (private `crc32`), `base64.ts`, `sha256.ts`, `canonicalJson.ts` | Enough to **write** a ZIP container | No inflate, so no XLSX read |
| CLI save | `server/src/cli/saveFiles.ts` | `--save` writes `data.files[]`, base64 keys (`stlBase64`, `stepBase64`, `base64`) or text keys (`text`, `step`, `stl`, `ifc`, `dxf`, `svg`, `content`) | An `xlsxBase64` key must be added (or `base64` reused) |
| Human gate | `packages/core/src/commands/types.ts` (`ExecutionContext.humanSignature?: HumanSignaturePort`), used by `setExportMarking.ts`, `domain-cae/thermal/dispose.ts` | Signature verification port for human-gated acts | No deliverable status |

`node_modules` were not installed in the authoring sandbox, so `llull describe` was not run; the table above is from
the source files.

## 2. Target architecture

- **Plugin** `plantData` in `packages/domain-aec/src/plant/data/` (decision: inside `domain-aec`, beside `industrial/`,
  because it classifies building elements and shares the IFC writer). MCP toolset **`plant`**, shared with the
  sibling plant gaps (01–07, 09, 10); `packages/mcp/src/toolsets.ts` gains the getter. Installed by
  `src/app/plugins.ts`.
- **Exchange code** stays with the IFC writer in `packages/domain-aec/src/building/exchange/`: `export_ifc` gains a
  `schema` param; the IFC 4.3 plant mapping lives in new files `ifcPlant.ts`, `ifcPorts.ts`, `ifcPlantHierarchy.ts`
  that read the `plant` slice through pure view functions of the plugin (`plant/data/view.ts`). The building plugin
  imports those view functions only (same package; no cycle: `plant/data` does not import `building/exchange`).
- **Pure helpers** go to `packages/core/src/lib/`: `crc32.ts` (moved out of `png.ts`), `zipWrite.ts` (stored + deflate
  entries, fixed timestamps), `inflate.ts` (RFC 1951 decoder, V1), `xlsxWrite.ts` / `xlsxRead.ts` (SpreadsheetML
  subset), `stepRead.ts` (the tokenizer of `tests/production/oracle/ifc.ts` promoted so commands can use it). None
  touches the DOM, network or `fs` (L2).
- **Object providers** (open / closed, C6): plant objects reference model objects by `{ kind, id }`. A provider per
  kind answers `exists`, `label`, `geometrySummary` (length, DN, ends, ports) and `ifcHint`. DAT ships providers for
  building elements (`equipment`, `pipe`, `tray`, `pipeSupport`, `member`). Siblings register theirs (03 EQP
  `nozzle`, 01/02 `pipeComponent`, 04 PID `instrument`, `pidSymbol`) in their own plugin through
  `plant/data/providers.ts` `registerPlantObjectProvider` (a module-level table filled at install time by the
  composition root, the same pattern as plugin guards). No core change.
- **Commands are pure** (L1/L3): every mutation returns a new document with a new `plant` slice; queries return
  `data`. No kernel is needed (L9): reports and IFC use stored geometry (polylines, sizes); solids for IFC bodies are
  the same extrusions the IFC4 export writes today.
- **Determinism** (L8, AF-13): plant object ids are step-scoped (`plantobj-<step>.<k>`), so replay re-mints them; tags
  are a pure function of class format + fields + hierarchy; sequence numbers come from the document (never time or
  randomness); IFC GlobalIds use the existing `ifcGuid(<uid>:<seed>)` with seeds listed in §5.6.
- **Human gate** (AF-34): `set_deliverable_status` to `issued_for_approval`, `issued_for_construction` or `as_built`
  needs `ctx.humanSignature` to verify a signature over the deliverable's content hash (09 PLM pattern).

```
packages/domain-aec/src/plant/data/
  model.ts              PlantDataModel types, getPlant(doc), withPlant(doc, plant)
  validate.ts           DocumentExtension.validate (ids, references, tag uniqueness, hierarchy acyclic)
  classes.ts            class resolution (inheritance, property merge), default library loader
  library/process.ts    default process class library (data, with IFC mapping and sources)
  tagFormat.ts          grammar, parse, generate, regex, next free sequence
  registry.ts           derived tag index, uniqueness scope, reserved tags
  providers.ts          PlantObjectProvider table + building-element providers
  lines.ts              line records, from/to resolution, battery-limit rule
  properties.ts         typed values, unit conversion, provenance
  reports/              lineList.ts equipmentList.ts nozzleSchedule.ts valveList.ts instrumentIndex.ts mto.ts tagRegister.ts table.ts
  roundTrip.ts          sheet <-> rows, diff, classification of changes
  deliverables.ts       status machine, content hash
  handover.ts           CFIHOS-like registers (V2)
  check.ts              check_plant_data rules
  codes.ts              DAT_* codes + remediation text
  *Command.ts, catalog.ts, plugin.ts
packages/domain-aec/src/building/exchange/
  ifcBuild.ts (schema param)  ifcPlant.ts  ifcPorts.ts  ifcPlantHierarchy.ts  ifcSummary.ts  idsCheck.ts (V1)
packages/core/src/lib/
  crc32.ts zipWrite.ts xlsxWrite.ts stepRead.ts inflate.ts (V1) xlsxRead.ts (V1)
```

### 2.1 Technical requirements

| Id | Pri | Requirement | FR | AF |
| -- | --- | ----------- | -- | -- |
| TR-DAT-01 | MUST | Plugin `plantData` in `packages/domain-aec/src/plant/data/`, toolset `plant`, installed by the composition root; no core import of it (L10). | all | AF-01 |
| TR-DAT-02 | MUST | `CadDocument.plant?` slice declared by `DocumentExtension` (validate / restore); additive, format version unchanged (§3). | 01, 02 | AF-13 |
| TR-DAT-03 | MUST | Class resolution with inheritance, tightening only, cycle refusal; library classes read-only (§5.1). | 02, 03 | AF-30 |
| TR-DAT-04 | MUST | Default process class library as data with IFC mapping and source per class (§5.5). | 03, 17 | AF-30, AF-35 |
| TR-DAT-05 | MUST | Object providers `{ kind, id }` for building elements; registration point for sibling gaps (§2). | 03, 10, 11 | AF-01 |
| TR-DAT-06 | MUST | Tag-format grammar, generation, anchored regex, next free sequence (§5.2). | 04 | AF-13 |
| TR-DAT-07 | MUST | Derived tag registry, scope rule, refusal with holder id and next free tag (§5.3). | 05 | AF-11 |
| TR-DAT-08 | MUST | Line objects, pipe binding, from / to resolution with a named battery-limit default (§5.4). | 06, 09 | AF-31 |
| TR-DAT-09 | MUST | Hierarchy tree with kind order site > plant > area > unit > system; hierarchy fields usable in tag formats. | 01 | — |
| TR-DAT-10 | MUST | `set_plant_properties` validates the whole batch and applies it as one feature step or refuses it whole; `is pure`. | 07 | AF-42 |
| TR-DAT-11 | MUST | Report engine: pure `(doc, filter) → { columns, rows }`, typed column descriptors with units (§5.9). | 08–11 | AF-10 |
| TR-DAT-12 | MUST | MTO grouping with `method` (`centreline` / `cutLength`) and per-row source. | 12 | AF-35 |
| TR-DAT-13 | MUST | CSV through the existing `toCsv`; files returned as `data.files[]` for `--save`. | 13 | AF-12 |
| TR-DAT-14 | MUST | Natural tag sort; stable column order; bounded output with paging. | 08, 20 | AF-12, AF-13 |
| TR-DAT-15 | MUST | Deterministic XLSX writer in `@lib` (fixed ZIP order and timestamps, locked read-only columns) (§5.10). | 13, 14 | AF-13 |
| TR-DAT-16 | SHOULD | XLSX reader (inflate + SpreadsheetML subset), values only, formula cells need cached values (§5.10). | 14 | AF-11 |
| TR-DAT-17 | SHOULD | Import diff with preview / apply, change ids, per-cell refusal codes, single composed batch (§5.11). | 14, 15 | AF-11, AF-42 |
| TR-DAT-20 | MUST | `export_ifc` `schema` param; IFC4X3_ADD2 header and entity set; IFC4 stays default; `Tag` written in both (§5.5). | 16 | AF-10 |
| TR-DAT-21 | MUST | Class → IFC entity + PredefinedType from the schema enum, `USERDEFINED` ⇒ `ObjectType`, proxies listed in `data.proxies` (§5.5). | 17 | AF-21 |
| TR-DAT-22 | MUST | Ports, nests, one SOURCE → SINK connection relationship per physical connection, inferred nozzles flagged, pipelines as `IfcDistributionSystem` (§5.6). | 18 | AF-21 |
| TR-DAT-23 | MUST | IFC 4.3 spatial structure `IfcSite` → `IfcFacility` → `IfcFacilityPartCommon` (§5.7). | 01, 16 | — |
| TR-DAT-24 | MUST | SI unit assignment for pressure, temperature, mass; template Psets + `Pset_llullPlant` with provenance (§5.8). | 16, 25 | AF-04, AF-32 |
| TR-DAT-25 | SHOULD | `stepRead` tokenizer in `@lib`; `ifc_summary` with physical-connection counting (§5.12). | 22 | AF-10 |
| TR-DAT-26 | SHOULD | IDS 1.0 checker subset with parity to ifctester on the pack files (§5.12). | 19 | AF-20 |
| TR-DAT-27 | MUST | Determinism: step-scoped ids, tags as pure functions, GlobalId seeds of §5.6, byte-identical files. | 20 | AF-13 |
| TR-DAT-28 | SHOULD | Deliverable status machine with `ctx.humanSignature` gate and `reviewRequired` (§5.14). | 24 | AF-33, AF-34 |
| TR-DAT-29 | COULD | Handover registers from a mapping table, `unverified` until checked (§5.15). | 23 | AF-32 |
| TR-DAT-30 | MUST | `check_plant_data` rules and the `DAT_*` code table with remediation (§5.13, §7). | 21 | AF-11, AF-20 |
| TR-DAT-40 | SHOULD | Performance budgets of §8, measured by a bench. | — | AF-40 |

## 3. Data model

The plant slice is an optional top-level field declared through the plugin's `DocumentExtension` (validate / restore),
like `building` and `civil`. It is additive: the document format version stays 3; an older build keeps the unknown
slice and re-serialises it (same behaviour as recorded for `plm` in 09 TR-PLM-10), so no migration is needed.

```ts
// packages/domain-aec/src/plant/data/model.ts (sketch)
export type HierarchyKind = 'site' | 'plant' | 'area' | 'unit' | 'system';

export interface HierarchyNode {
  readonly id: string;               // step-scoped
  code: string;                      // "U10"; unique among siblings
  kind: HierarchyKind;
  name: string;
  parentId: string | null;           // site has none; kind order site > plant > area > unit > system
  properties: Record<string, PlantValue>;   // e.g. areaNumber: "1" (used by tag formats)
}

export type PropertyType = 'text' | 'integer' | 'real' | 'boolean' | 'enum' | 'length' | 'pressure' | 'temperature' | 'mass' | 'volumetricFlow' | 'massFlow';

export interface PropertyDefinition {
  name: string;                      // identifier, no spaces (Plant 3D rule [R7])
  displayName: string;
  type: PropertyType;
  unit?: string;                     // required for physical types: 'mm' | 'barg' | 'bara' | 'kPa' | 'degC' | 'K' | 'kg' | 'm3/h' | 'kg/h' …
  enumValues?: string[];
  pattern?: string;                  // anchored regex for text
  required?: boolean;
  readOnly?: boolean;                // derived or format-driven (tag), never edited by import
  derivedFrom?: 'geometry' | 'tag' | 'hierarchy';
  default?: PlantValue;
}

export interface IfcMapping {
  entity: string;                    // 'IfcPump', 'IfcValve', 'IfcPipeSegment', 'IfcDistributionSystem', …
  predefinedType?: string;           // a value of the entity's enum; else USERDEFINED + objectType
  objectType?: string;
  pset?: string;                     // template Pset to fill, e.g. 'Pset_PumpTypeCommon'
  propertyMap?: Record<string, string>;     // class property -> Pset property
}

export interface PlantClass {
  name: string;                      // unique; PascalCase identifier
  parent: string | null;
  abstract: boolean;
  classCode?: string;                // used by {classCode}
  tagFormat?: string;                // §5.2 grammar; inherited
  tagScope: 'plant' | 'site' | 'project';   // default 'plant'
  properties: PropertyDefinition[];
  ifc?: IfcMapping;
  externalIds?: { scheme: 'cfihos' | 'iso15926' | 'company'; id: string; verified: boolean }[];   // V2
  source: 'library' | 'project';
}

export type PlantValue = string | number | boolean | null;

export interface ValueProvenance { source: 'pid' | 'datasheet' | 'calculation' | 'agent' | 'import' | 'default'; ref?: string; unverified?: boolean }

export type PlantObjectTarget =
  | { kind: 'buildingElement'; id: string }        // equipment, pipe, tray, pipeSupport, member
  | { kind: 'provider'; provider: string; id: string }   // sibling objects: nozzle, pipeComponent, instrument, pidSymbol
  | { kind: 'reserved' };                            // tag reserved before its object exists

export interface PlantObject {
  readonly id: string;               // 'plantobj-<step>.<k>'
  className: string;
  hierarchyId: string;
  target: PlantObjectTarget;
  tagFields: Record<string, PlantValue>;   // the variable fields of the format (seq, fluidCode, …)
  tag: string;                       // cached = generate(format, fields, class, hierarchy); validate() recomputes and compares
  properties: Record<string, PlantValue>;
  provenance?: Record<string, ValueProvenance>;
  lineId?: string;                   // components / pipes that belong to a process line object
}

export interface ReportDefinition { id: string; kind: ReportKind; columns?: string[]; filter?: ReportFilter; sort?: string[]; groupBy?: string[] }

export type DeliverableStatus = 'in_work' | 'issued_for_review' | 'issued_for_approval' | 'issued_for_construction' | 'as_built' | 'superseded';

export interface Deliverable {
  id: string;                        // 'line_list', 'equipment_list', 'ifc', or a report definition id
  revisions: { label: string; status: DeliverableStatus; contentSha256: string; at: string; by: string; signatureId?: string }[];
}

export interface PlantDataModel {
  hierarchy: Record<string, HierarchyNode>;
  hierarchyOrder: string[];
  classes: Record<string, PlantClass>;
  objects: Record<string, PlantObject>;
  objectOrder: string[];
  settings: { batteryLimitPattern: string; defaultTagScope: 'plant' | 'site' | 'project'; unitsSystem: 'SI' | 'US' };
  reports: Record<string, ReportDefinition>;
  deliverables: Record<string, Deliverable>;
}
```

Invariants checked by `validate.ts` (a file breaking one is refused on load):

- every `hierarchyId`, `className`, `lineId` resolves; the hierarchy is a tree with kind order respected;
- every non-reserved `target` resolves through its provider (a deleted building element leaves its plant object as an
  orphan: `check_plant_data` reports `DAT_OBJECT_ORPHAN`, load does not fail);
- `tag` equals `generate(...)` and is unique within its scope;
- property values match their definition (type, enum, pattern, unit).

The **tag registry** is derived (`registry.ts` builds `Map<scopeKey, Map<tag, objectId>>` on demand, cached by
document identity), never stored, so it cannot diverge from the objects.

Existing fields stay the source of geometry: a line's length comes from its pipe runs; equipment size from
`EquipmentElement`. `EquipmentElement.mark` and `PipeElement.line` are kept in sync by DAT commands when an object is
tagged (the tag is written to `mark` / `line` through the building commands `update_equipment` / `update_pipe` via
`execute`, L10), so existing schedules, plan sheets and the IFC4 export show the tag.

## 4. Commands (toolset `plant`)

All mutating commands compose building commands only through `execute`. All carry `@affects / @invariant / @failure`
tags. Units of every physical param are in the schema description (AF-04).

| Name | Kind | Params (sketch) | Result `data` | Failure codes |
| ---- | ---- | --------------- | ------------- | ------------- |
| `define_plant_hierarchy` | mutating | `nodes[{ code, kind, name?, parent?, properties? }]`, `replace?` | `{ nodeIds }` | `DAT_HIERARCHY_INVALID`, `DAT_HIERARCHY_DUPLICATE_CODE` |
| `define_plant_class` | mutating | `name, parent?, abstract?, classCode?, tagFormat?, tagScope?, properties[]?, ifc?` | `{ className, resolvedProperties }` | `DAT_CLASS_EXISTS`, `DAT_CLASS_PARENT_UNKNOWN`, `DAT_CLASS_CYCLE`, `DAT_TAG_FORMAT_INVALID`, `DAT_PROPERTY_DEFINITION_INVALID`, `DAT_IFC_MAPPING_INVALID`, `DAT_LIBRARY_CLASS_LOCKED` |
| `load_plant_class_library` | mutating | `library: 'llull-default-process'`, `classes?[]` | `{ added, skipped }` | `DAT_LIBRARY_UNKNOWN` |
| `set_tag_format` | mutating | `className, tagFormat, retag?: boolean` | `{ changedTags[{ id, from, to }] }` | `DAT_TAG_FORMAT_INVALID`, `DAT_TAG_DUPLICATE` (when `retag` collides) |
| `assign_plant_object` | mutating | `target` (alias / element id / `{provider,id}` / `"reserved"`), `className, hierarchy, tagFields? \| tag?, nextSequence?: boolean, properties?, provenance?, line?` | `{ objectId, tag }` | `DAT_CLASS_UNKNOWN`, `DAT_CLASS_ABSTRACT`, `DAT_TARGET_UNKNOWN`, `DAT_TARGET_ALREADY_TAGGED`, `DAT_TAG_FORMAT`, `DAT_TAG_FIELD_MISSING`, `DAT_TAG_DUPLICATE`, `DAT_PROPERTY_TYPE`, `DAT_HIERARCHY_UNKNOWN` |
| `set_plant_properties` | mutating | `edits[{ object (id or tag), property, value, provenance? }]` (≤ 10 000) | `{ changed, objects }` | `DAT_OBJECT_UNKNOWN`, `DAT_PROPERTY_UNKNOWN`, `DAT_PROPERTY_READONLY`, `DAT_PROPERTY_TYPE`, `DAT_PROPERTY_UNIT` — whole batch refused |
| `unassign_plant_object` | mutating | `objects[]` | `{ removed }` | `DAT_OBJECT_UNKNOWN` |
| `renumber_tags` (V1) | mutating | `className, hierarchy?, startSequence, step? (default 1)` — new `seq` = startSequence + k·step for the k-th object in natural tag order, reserved tags included | `{ mapping[{ from, to }] }` | `DAT_TAG_DUPLICATE`, `DAT_RENUMBER_RANGE` |
| `plant_data_table` | query | `className, includeSubclasses?, hierarchy?, columns?, filter?, sort?, offset?, limit? (≤ 2000)` | `{ columns[{ name, type, unit, readOnly }], rows[], total }` | `DAT_CLASS_UNKNOWN`, `DAT_COLUMN_UNKNOWN` |
| `plant_report` | query | `kind: line_list \| equipment_list \| nozzle_schedule \| valve_list \| instrument_index \| mto \| tag_register \| custom`, `definition?`, `hierarchy?`, `groupBy?`, `format: json \| csv \| xlsx` | `{ kind, columns, rows, rowsByTag?, totals?, method, csv? \| xlsxBase64?, fileName }` | `DAT_REPORT_KIND_UNAVAILABLE` (needs a sibling gap), `DAT_COLUMN_UNKNOWN` |
| `save_report_definition` (V1) | mutating | `id, kind, columns?, filter?, sort?, groupBy?` | `{ id }` | `DAT_COLUMN_UNKNOWN` |
| `export_plant_data` | query | `classes[], hierarchy?, format: xlsx \| csv, includeReadOnly? (default true)` | `{ files[{ fileName, base64 \| content }], sheets{ <class>: { rows, columns } } }` | `DAT_CLASS_UNKNOWN` |
| `import_plant_data` (V1) | mutating in `apply`, read-only in `preview` | `fileBase64 \| csv, sheet?, mode: preview \| apply, accept?: changeId[]` | `{ changes[{ changeId, objectId, tag, property, from, to }], rejected[{ row, column, code, message }], applied, documentChanged }` | `DAT_IMPORT_FORMAT`, `DAT_IMPORT_KEY_MISSING`, `DAT_IMPORT_UNKNOWN_OBJECT`, `DAT_IMPORT_UNKNOWN_COLUMN`, `DAT_IMPORT_READONLY_COLUMN`, `DAT_IMPORT_TYPE`, `DAT_IMPORT_FORMULA`, `DAT_IMPORT_STALE` |
| `import_tag_list` (V1) | mutating | `fileBase64 \| csv, className, hierarchy, mode` | `{ reserved, rejected }` | as above + `DAT_TAG_DUPLICATE` |
| `check_plant_data` | query | `hierarchy?, classes?, severity?` | `{ status: pass \| warn \| fail, findings[{ code, severity, ids, paths, message, remediation }], counts }` | — |
| `export_ifc` (extended) | query | existing + `schema?: 'IFC4' \| 'IFC4X3_ADD2'` (default `IFC4`), `plant?: { ports?: boolean (default true), systems?: 'line' \| 'none', hierarchy?: boolean }` | existing + `schema, counts{ <IfcClass>: n }, ports, connections, openPorts, proxies[{ id, reason }]` | existing + `DAT_IFC_MAPPING_MISSING` (warning in data, not a refusal) |
| `ifc_summary` (V1) | query | `ifc` (text) | `{ schema, entityCount, counts, predefinedTypes, systems[{ name, predefinedType, members }], ports, connections, physicalConnections, openPorts, duplicateTags, errors[] }` | `DAT_IFC_PARSE` |
| `check_ifc_requirements` (V1) | query | `ids` (text), `ifc?` (text; default = export of the current document with `schema` from the IDS) | `{ specifications[{ name, status, applicable, failed, failedGlobalIds[] }] }` | `DAT_IDS_PARSE`, `DAT_IDS_UNSUPPORTED_FACET` |
| `set_deliverable_status` (V1) | mutating; human-gated states | `deliverable, revision, status, signature?` | `{ deliverable, revision, status, contentSha256, reviewRequired }` | `DAT_STATUS_TRANSITION`, `DAT_HUMAN_GATE`, `DAT_SIGNATURE_INVALID`, `DAT_CHECK_FAILED` (issue with a failing `check_plant_data`) |
| `export_handover` (V2) | query | `profile: 'cfihos-subset' \| 'generic', registers?[]` | `{ files[], unverified, mappingSource }` | `DAT_HANDOVER_MAPPING_MISSING` |

Representative tags (C2):

```ts
/**
 * @affects plant.objects (+1), building element mark / line (via update_equipment / update_pipe)
 * @invariant tag = generate(class.tagFormat, tagFields, class, hierarchy) and is unique in its scope
 * @failure unknown / abstract class, unknown target, malformed or duplicate tag, invalid property -> refusal with DAT_* code, doc unchanged
 */
export const assignPlantObject = defineCommand({ name: 'assign_plant_object', … });

/**
 * @affects none; data = { kind, columns, rows, … }
 * @invariant rows sorted by natural tag order; identical input -> identical csv / xlsx bytes
 * @failure report kind whose objects come from a gap not installed -> DAT_REPORT_KIND_UNAVAILABLE
 */
export const plantReport = defineCommand({ name: 'plant_report', annotations: { readOnly: true, idempotent: true }, … });
```

## 5. Algorithms

### 5.1 Class resolution (TR-DAT-03)

`resolve(className)` walks `parent` to the root (refuses a cycle with `DAT_CLASS_CYCLE` at definition time), then
merges properties root-first: a child may tighten a parent property (`required: true`, narrower `enumValues`, a
`default`) but may not change its `type` or `unit` (`DAT_PROPERTY_DEFINITION_INVALID`). `tagFormat`, `classCode` and
`ifc` are inherited unless set. Library classes (`source: 'library'`) are read-only; a project extends them by
subclassing.

### 5.2 Tag formats (TR-DAT-06)

Grammar:

```
format   := part+
part     := literal | field
literal  := any characters except '{' and '}' ; '{{' and '}}' escape braces
field    := '{' name (':' width)? '}'
name     := 'classCode' | 'hierarchy.' code-kind '.' prop | identifier       // identifier = a class property or a tagField
width    := digits                                                             // zero padding of integers
```

- `generate(format, fields)`: each field is taken from `tagFields`, then the object's properties, then the class
  (`classCode`), then the hierarchy (`{area}` is an alias of `hierarchy.unit.areaNumber` then
  `hierarchy.area.areaNumber`); integers are zero-padded to `width`; a missing field refuses with
  `DAT_TAG_FIELD_MISSING` naming the field.
- `regex(format, class)`: literals are escaped; a padded integer field becomes `[0-9]{width}` (or `[0-9]{width,}` for
  `{seq:4}` when `allowOverflow`), an enum property becomes an alternation of its values, a patterned property its
  pattern, other fields `[^<next literal>]+`. The regex is anchored. An explicit `tag` is accepted only if it matches
  and, when parsed back, yields fields consistent with the object's properties (else `DAT_TAG_FORMAT`).
- `nextSequence(scope, class, prefix)`: the smallest integer ≥ 1 not used by a tag with the same non-sequence
  fields, so deleted numbers are reused only when `reuseNumbers: true` (default false: max + 1, as `nextMark` does).
- Comparison: tags are compared after Unicode NFC normalisation and trimming, case-sensitively; a case-only collision
  is a warning `DAT_TAG_CASE_COLLISION`.

The validation cases are in `validation/data/tag_format_cases.json` (VC-DAT-01, 02).

### 5.3 Registry and uniqueness (TR-DAT-07)

Scope key = the id of the ancestor node of kind `tagScope` (`plant` by default; `project` = the root). A tag is unique
per scope among plant objects, including reserved ones. `assign_plant_object` refuses a duplicate with `ids` = the
holder and a remediation naming the next free sequence. `validate.ts` refuses a file with duplicates (hand-edited
JSON).

### 5.4 Lines and ends (TR-DAT-08)

A process line object (class `ProcessLine` or subclass) owns pipe runs through `lineId` on the pipe's plant object
(MVP: one pipe run per line is typical, several allowed). `from` / `to` are read from the line object's properties,
falling back to the pipe's `from` / `to`. Resolution: (1) a tag in the same scope → `resolved`, (2) a match of
`settings.batteryLimitPattern` (named default `^(BL|TI)-`, reported in `data.defaults` per AF-31) → `batteryLimit`,
(3) otherwise `DAT_LINE_END_UNRESOLVED` with `paths: ['<line>.from' | '<line>.to']`.

Line list length = Σ over the line's pipe runs of `routeLength(points)` (existing `routeSupport.ts`), converted to
metres with `toMetres`; bends = Σ (points − 2). With 02 RTE components, length = Σ straight pipe cut lengths and the
column `method` switches from `centreline` to `cutLength`.

### 5.5 IFC 4.3 class mapping (TR-DAT-20, 21)

Default library mapping (enumeration values from the IFC4X3_ADD2 schema, `validation/data/reference/ifc4x3_add2_plant_schema_facts.json`):

| llull class family | IFC entity | PredefinedType |
| ------------------ | ---------- | -------------- |
| straight pipe (from `add_pipe_run` straights, 02 RTE pipe) | `IfcPipeSegment` | `RIGIDSEGMENT` (`FLEXIBLESEGMENT` for hoses, `SPOOL` for a spool assembly — 05 ISO) |
| bend / elbow | `IfcPipeFitting` | `BEND` |
| tee, branch outlet | `IfcPipeFitting` | `JUNCTION` |
| reducer | `IfcPipeFitting` | `TRANSITION` |
| flange, coupling, union | `IfcPipeFitting` | `CONNECTOR` |
| cap, blind | `IfcPipeFitting` | `EXIT` |
| gate / ball / butterfly (isolation) valve | `IfcValve` | `ISOLATING` |
| globe / control valve | `IfcValve` | `REGULATING` |
| check valve | `IfcValve` | `CHECK` |
| safety / relief valve | `IfcValve` | `PRESSURERELIEF` |
| pressure-reducing valve | `IfcValve` | `PRESSUREREDUCING` |
| three-way valve | `IfcValve` | `DIVERTING` or `MIXING` (class property) |
| steam trap | `IfcValve` | `STEAMTRAP` |
| storage tank | `IfcTank` | `STORAGE` |
| pressure vessel, drum | `IfcTank` | `PRESSUREVESSEL` |
| column (tower) | `IfcTank` | `USERDEFINED`, `ObjectType 'COLUMN'` (open question Q3) |
| centrifugal pump (end suction / in-line / split case / vertical turbine) | `IfcPump` | `ENDSUCTION` / `VERTICALINLINE` / `SPLITCASE` / `VERTICALTURBINE` |
| compressor | `IfcCompressor` | `DYNAMIC` / `RECIPROCATING` / `ROTARY` … |
| shell-and-tube / plate exchanger | `IfcHeatExchanger` | `SHELLANDTUBE` / `PLATE` |
| flow meter (in-line) | `IfcFlowMeter` | `USERDEFINED` (enum values are utility meters) |
| transmitter / sensor | `IfcSensor` | `FLOWSENSOR`, `PRESSURESENSOR`, `TEMPERATURESENSOR`, `LEVELSENSOR` |
| local gauge | `IfcFlowInstrument` | `PRESSUREGAUGE`, `THERMOMETER` |
| actuator | `IfcActuator` | `PNEUMATICACTUATOR`, `ELECTRICACTUATOR`, `HYDRAULICACTUATOR`, `HANDOPERATEDACTUATOR` |
| process line | `IfcDistributionSystem` | `USERDEFINED`, `ObjectType 'PIPELINE'` (or a matching enum: `COMPRESSEDAIR`, `FUEL`, `GAS`, `CHILLEDWATER`, `FIREPROTECTION`, `DRAINAGE`, `VENT`, `CHEMICAL`, `OIL`, `WATERSUPPLY` … chosen by the class property `ifcSystemType`) |
| cable tray | `IfcCableCarrierSegment` | `CABLETRAYSEGMENT` (unchanged) |
| pipe support | `IfcBuildingElementProxy` `ObjectType 'PIPESUPPORT'` (unchanged; open question Q4: `IfcDiscreteAccessory`, whose enum has `BRACKET`, `SHOE`, …) | |
| unclassified equipment | `IfcBuildingElementProxy` `ELEMENT` (listed in `data.proxies`) | |

`USERDEFINED` always sets `ObjectType` (EXPRESS rule `CorrectPredefinedType`, found by the validator in the negative
reference file). Each product gets `Tag` = plant tag, `Name` = tag, `Description` = class display name + description
property, `ObjectType` as above.

### 5.6 MVP decomposition of pipe runs and ports (TR-DAT-22)

For a `PipeElement` with points p0…pn (n ≥ 1) in IFC4X3 mode:

1. straight k (k = 0…n−1) → `IfcPipeSegment`, seed `<pipe.id>:seg:<k>`, body = today's extruded circle of that
   straight, `Pset_PipeSegmentTypeCommon { NominalDiameter (DN, mm), OuterDiameter, Length }`;
2. interior vertex k (k = 1…n−1) → `IfcPipeFitting BEND`, seed `<pipe.id>:bend:<k>`, placed at the vertex, no body in
   the MVP (no bend radius is modelled yet; 02 RTE adds geometry);
3. ports: each segment and bend gets an inlet (`SINK`, seed `…:in`) and an outlet (`SOURCE`, seed `…:out`), placed at
   its ends, `PredefinedType PIPE`, `SystemType` = the system enum of the line (or `USERDEFINED`), nested in order
   (inlet, outlet) with one `IfcRelNests` per element, `Pset_DistributionPortTypePipe { NominalDiameter,
   ConnectionType }`;
4. connections in route order: outlet(k) → inlet(k+1), one `IfcRelConnectsPorts` each, RelatingPort = the SOURCE port,
   RelatedPort = the SINK port (IFC *Port Connectivity* concept [R2]);
5. ends: if `from` names equipment whose footprint contains p0 (the containment test already used by
   `check_clashes` for "pipe connections"), the equipment gets an **inferred nozzle port** (`SOURCE`, seed
   `<equipment.id>:nozzle:<pipe.id>:from`, `Description 'inferred from line from/to'`, `Name` N1, N2 … in creation
   order) connected to the first inlet; symmetrically for `to` (a `SINK` port). With 03 EQP nozzles present, the
   nozzle's own port is used and nothing is inferred. An unmatched end leaves an open port; it is a finding only if
   the end is not a battery limit;
6. the line's `IfcDistributionSystem` groups its segments, fittings and inline components (`IfcRelAssignsToGroup`).

For SC-DAT-01 this gives 5 segments, 3 bends, 19 ports, 10 nests, 9 connections, 1 open port, 2 systems — the
counts of `validation/data/reference/sc-dat-01-reference.ifc` (VC-DAT-07, 08).

Flow direction: route order is from `from` to `to`; a line with `bidirectional: true` exports `SOURCEANDSINK` ports
and the connection order follows the route.

### 5.7 Spatial structure in IFC 4.3 (TR-DAT-23)

`IfcProject` → `IfcSite` (hierarchy site) → `IfcFacility` (plant; `ObjectType 'PROCESSPLANT'`; `IfcFacility` is
instantiable, `IfcFacilityPart` is abstract in ADD2 — found by the validator) → `IfcFacilityPartCommon`
(`USERDEFINED`, `ObjectType 'AREA'` / `'UNIT'`, `UsageType NOTDEFINED`) → elements by
`IfcRelContainedInSpatialStructure`. Building levels still export as `IfcBuilding` / `IfcBuildingStorey` (an
`IfcBuilding` is an `IfcFacility` subtype) for elements without a plant object. An element that has both a level and
a plant node is contained in the plant node; the storey elevation is kept in `Pset_llullPlant.Level`.

### 5.8 Units and property sets (TR-DAT-24)

IFC4X3 mode adds `IfcSIUnit` for pressure (PASCAL), thermodynamic temperature (KELVIN; values converted from degC
with +273.15), mass (KILO GRAM) and volumetric flow (cubic metre per second as a derived unit). Gauge pressures are
converted to Pa gauge and the property description says "gauge" (IFC has no gauge flag). A project property set
`Pset_llullPlant` carries the class name, hierarchy path, line number, spec, fluid code, design and operating
conditions with units in their descriptions, and the provenance flag `Unverified` when set (AF-32).

### 5.9 Reports (TR-DAT-11 … 14)

All report kinds are pure functions `(doc, filter) → { columns, rows }`:

- sort = natural tag order (digit runs compared as integers, then code points), so `P-2` < `P-10`;
- column descriptors carry `name`, `displayName`, `type`, `unit`, `readOnly`, `source` (`property`, `geometry`,
  `derived`);
- **line list**: one row per line object: designation fields, from, to, resolution of each end, DN, spec, fluid,
  length m, bends, design / operating P and T, insulation, test pressure, hierarchy path;
- **equipment list**: one row per equipment-family object: tag, class, description, hierarchy, size, weight (kg),
  design conditions;
- **nozzle schedule**: one row per nozzle (inferred or 03 EQP): equipment tag, nozzle name, DN, rating (from 01 PSC
  when present), facing, flow direction, connected line, `inferred`;
- **valve list** / **instrument index**: rows from provider objects (01/02, 04); unavailable providers refuse with
  `DAT_REPORT_KIND_UNAVAILABLE` naming the gap;
- **MTO**: group by `groupBy` (default `spec, itemType, nominalSize`); pipe quantity in m (centreline in MVP;
  `cutLength` with 02 RTE), components in `ea`; `method` and per-row `source` reported (AF-35);
- **tag register**: every tag in scope with class, target kind, status (`modelled` / `reserved`), hierarchy.

CSV via the existing `toCsv`. XLSX via `xlsxWrite` (§5.10).

### 5.10 XLSX writer and reader (TR-DAT-15, 16)

Writer (MVP): a SpreadsheetML package with `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels`, `xl/styles.xml` (two cell formats: locked, unlocked), one `xl/worksheets/sheetN.xml` per
table. Strings are inline (`t="inlineStr"`), numbers plain `<v>`; booleans `t="b"`. Read-only columns use the locked
format and the sheet carries `<sheetProtection sheet="1"/>` (no password: protection marks intent, as in Plant 3D
[R6], it is not security). Column A is `ObjectId` (locked). The ZIP is written with deflate (`deflateRaw`) and CRC-32,
entries in a fixed order with a fixed DOS timestamp 1980-01-01 00:00, so the bytes are deterministic (VC-DAT-11).

Reader (V1): `inflate.ts` (RFC 1951: stored, fixed and dynamic Huffman blocks) + a tolerant XML scanner for
`sheetN.xml`, `sharedStrings.xml` and `workbook.xml`. It reads values only: a cell with a formula uses its cached
value `<v>`; without one it is rejected `DAT_IMPORT_FORMULA`. Dates are not plant property types and are read as
numbers. Size cap 20 MB uncompressed (`DAT_IMPORT_FORMAT` above it). Alternative kept open (Q5): decompress in the
CLI / server host with `node:zlib` and pass the XML parts to the command.

### 5.11 Import diff (TR-DAT-17)

1. Parse the sheet into a header and rows; map header cells to properties by `displayName` (then `name`), unknown
   columns → `DAT_IMPORT_UNKNOWN_COLUMN` (whole column rejected, rest continues).
2. Key = `ObjectId` (fallback `Tag` with `keyColumn: 'Tag'`); a missing key → `DAT_IMPORT_KEY_MISSING`; an unknown
   key → `DAT_IMPORT_UNKNOWN_OBJECT`.
3. For each cell: normalise (trim, numbers with the property unit, enums exact), compare with the current value;
   equal → skip; read-only → `DAT_IMPORT_READONLY_COLUMN`; type / enum / pattern failure → `DAT_IMPORT_TYPE`.
4. `changeId` = sha256 of `objectId|property|to` (first 12 hex) so an agent can accept a subset by id.
5. `preview` returns the lists with `documentChanged: false` and the original document. `apply` composes one
   `set_plant_properties` batch with the accepted changes (all, or `accept[]`) through `execute`, so the import is one
   feature step and undoable; provenance `import` with the file sha256.
6. Staleness: the export writes the document content hash in a hidden `_meta` sheet; on import a different hash is a
   warning `DAT_IMPORT_STALE` (values still diffed against the current document).

### 5.12 IFC summary and IDS check (TR-DAT-25, 26)

`stepRead.ts` tokenises ISO 10303-21 (header, `#n=ENTITY(args);`, strings with `''` and `\X2\` escapes, nested lists,
enums, `$`, `*`). `ifc_summary` counts entities by type, reads `PredefinedType` by schema attribute index (table for
the classes of §5.5 per schema), resolves `IfcRelAssignsToGroup` for systems, `IfcRelNests` for ports, and counts
`IfcRelConnectsPorts` both as relationships and as **physical connections** = unordered port pairs, so a file written
by IfcOpenShell's API (two reciprocal relationships per connection, observed in the reference run) and a llull file
report the same `physicalConnections`.

`check_ifc_requirements` implements the IDS 1.0 facets entity, attribute, property, classification and partOf with
`simpleValue`, `xs:pattern` (translated to an anchored JS regex), `xs:enumeration` and bounds; material facet and
`xs:length` in V2 (`DAT_IDS_UNSUPPORTED_FACET` until then). Its results are compared with ifctester's on the five
files of `ids_results.json` (VC-DAT-10).

### 5.13 Checks (TR-DAT-30)

`check_plant_data` rules, each with code, severity and remediation:

| Code | Severity | Rule |
| ---- | -------- | ---- |
| `DAT_TAG_FORMAT` | fail | stored tag does not match its class format (hand-edited file or changed format without `retag`) |
| `DAT_TAG_DUPLICATE` | fail | two objects share a tag in one scope |
| `DAT_TAG_CASE_COLLISION` | warn | tags differ only by case |
| `DAT_REQUIRED_PROPERTY_MISSING` | fail | a `required` property is empty |
| `DAT_LINE_END_UNRESOLVED` | fail | `from` / `to` is neither a tag nor a battery limit |
| `DAT_LINE_SIZE_MISMATCH` | warn | line nominal size ≠ DN of its pipe runs |
| `DAT_OBJECT_ORPHAN` | warn | the target of a plant object no longer exists |
| `DAT_UNCLASSIFIED_ELEMENT` | warn | an equipment / pipe element has no plant object |
| `DAT_OUTSIDE_HIERARCHY` | fail | object node missing (only possible in a hand-edited file) |
| `DAT_OPEN_PORT` | warn | a pipe end connected to nothing and not a battery limit |
| `DAT_INFERRED_NOZZLE` | info | nozzle inferred from from / to (no 03 EQP nozzle) |
| `DAT_VALUE_UNVERIFIED` | warn | a value with `unverified` provenance used in a report (cannot be hidden, AF-32) |
| `DAT_RESERVED_TAG_UNMODELLED` | info | reserved tag without a modelled object |

`status` = fail if any fail, else warn if any warn, else pass.

### 5.14 Deliverable status (TR-DAT-28)

Transitions: `in_work → issued_for_review → issued_for_approval → issued_for_construction → as_built`, any issued
state → `superseded` when a new revision is issued. `contentSha256` = sha256 of the canonical JSON of the report rows
(or of the IFC text) at issue. Agent callers may move to `issued_for_review`; `issued_for_approval`,
`issued_for_construction` and `as_built` need `signature` verified by `ctx.humanSignature` over `contentSha256`
(`DAT_HUMAN_GATE` without the port or for an agent; `DAT_SIGNATURE_INVALID` on failure), and a passing
`check_plant_data` for the deliverable's scope (`DAT_CHECK_FAILED`). Results carry `reviewRequired: true` with the
reason "computed by llull, not approved — needs a qualified engineer" until signed (AF-33). When 09 PLM lands, this
state machine is replaced by PLM items without changing the command surface (open question Q6).

### 5.15 Handover export (V2, TR-DAT-29)

Registers as CSV files: tag register (tag, class, parent tag, hierarchy codes, description, status), equipment
register (tag, manufacturer, model, serial when known), tag property values (tag, property, value, unit), document
register (deliverable, revision, status, sha256). Column names and class / property codes come from a mapping table
held as data (`classes[].externalIds`, a per-profile column map). Until that table is checked against an IOGP CFIHOS
release, every file is marked `unverified: true` and the summary says so.

## 6. Interop and persistence

| Format | Direction | Phase | Notes |
| ------ | --------- | ----- | ----- |
| llull document JSON (`plant` slice) | read / write | MVP | additive optional slice; `DocumentExtension.validate` / `restore` |
| CSV (RFC 4180) | write (reports, data); read (V1 import, tag lists) | MVP / V1 | UTF-8, `\n`, header row; numbers with `.` decimal |
| XLSX (SpreadsheetML subset) | write MVP, read V1 | MVP / V1 | §5.10; `data.files[].base64`, `fileName` → `--save` |
| IFC4 (ISO 16739-1:2018) | write | existing | unchanged default; gains `Tag` on tagged products |
| IFC4X3_ADD2 (ISO 16739-1:2024) | write MVP; summary V1; import V2 | MVP–V2 | §5.5–5.8 |
| IDS 1.0 | read | V1 | §5.12 |
| CFIHOS-like CSV registers | write | V2 | §5.15, `unverified` |
| ISO 15926 / POSC Caesar RDL | identifiers on classes | V2 | URIs stored in `externalIds`; no triple store |

CLI `--save`: add `xlsxBase64` to `BASE64_KEYS` in `server/src/cli/saveFiles.ts` or return `files[{ fileName, base64 }]`
(preferred: no host change).

## 7. CLI / MCP / UI surfaces and error codes

- CLI: every command above through `llull <command> '<json>'` and in plans; `llull guide` gains a "plant data"
  section (AF-03): units of each physical property type, tag-format grammar, hierarchy kinds, the minimal plan
  (SC-DAT-01).
- MCP: toolset `plant`; queries `readOnlyHint`; `import_plant_data` / `renumber_tags` / `set_tag_format` with
  `retag` `destructiveHint`.
- UI: Data Manager panel (grid over `plant_data_table`, edits dispatch `set_plant_properties`), Reports panel,
  Issue dialog (signature). Presentation only (L1).

| Code | Raised by | Meaning | Remediation |
| ---- | --------- | ------- | ----------- |
| `DAT_HIERARCHY_INVALID` | `define_plant_hierarchy` | unknown parent, kind order broken, cycle | give `parent` codes of an existing node of a higher kind |
| `DAT_HIERARCHY_DUPLICATE_CODE` | idem | two siblings with one code | rename one node |
| `DAT_HIERARCHY_UNKNOWN` | `assign_plant_object` | hierarchy code not found | call `define_plant_hierarchy` first |
| `DAT_CLASS_EXISTS` / `DAT_CLASS_UNKNOWN` / `DAT_CLASS_ABSTRACT` / `DAT_CLASS_PARENT_UNKNOWN` / `DAT_CLASS_CYCLE` | class commands | class lookup / definition errors | `plant_data_table` lists classes; subclass an abstract class |
| `DAT_LIBRARY_CLASS_LOCKED` / `DAT_LIBRARY_UNKNOWN` | idem | edit of a shipped class / unknown library | subclass it / use `llull-default-process` |
| `DAT_PROPERTY_DEFINITION_INVALID` | `define_plant_class` | type / unit change in a subclass, physical type without unit | keep the parent's type and unit |
| `DAT_IFC_MAPPING_INVALID` | `define_plant_class` | entity not in the schema or PredefinedType not in its enum | use a value from `ifc4x3_add2_plant_schema_facts.json` or `USERDEFINED` + `objectType` |
| `DAT_TAG_FORMAT_INVALID` | `define_plant_class`, `set_tag_format` | grammar error, unknown field | fix the braces / field names |
| `DAT_TAG_FORMAT` | `assign_plant_object`, check | tag does not match the class format | omit `tag` and give `tagFields` |
| `DAT_TAG_FIELD_MISSING` | `assign_plant_object` | a format field has no value | add it to `tagFields` or the properties |
| `DAT_TAG_DUPLICATE` | assign, `set_tag_format`, `renumber_tags`, check | tag already used in scope (`ids` = holder) | use `nextSequence: true` or the sequence in the remediation |
| `DAT_TAG_CASE_COLLISION` | check | case-only difference | rename one |
| `DAT_TARGET_UNKNOWN` / `DAT_TARGET_ALREADY_TAGGED` | assign | target not found / already has a plant object | check the alias; `unassign_plant_object` first |
| `DAT_OBJECT_UNKNOWN` | edits | id or tag not found | list with `plant_data_table` |
| `DAT_PROPERTY_UNKNOWN` / `DAT_PROPERTY_READONLY` / `DAT_PROPERTY_TYPE` / `DAT_PROPERTY_UNIT` | `set_plant_properties` | property errors (batch refused) | fix the listed `paths` and resend the batch |
| `DAT_REQUIRED_PROPERTY_MISSING` | check | required value empty | `set_plant_properties` |
| `DAT_LINE_END_UNRESOLVED` | check | from / to is not a tag nor a battery limit | tag the object, or name the end `BL-…` / `TI-…` |
| `DAT_LINE_SIZE_MISMATCH`, `DAT_OBJECT_ORPHAN`, `DAT_UNCLASSIFIED_ELEMENT`, `DAT_OUTSIDE_HIERARCHY`, `DAT_OPEN_PORT`, `DAT_INFERRED_NOZZLE`, `DAT_VALUE_UNVERIFIED`, `DAT_RESERVED_TAG_UNMODELLED` | check | §5.13 | named per finding |
| `DAT_REPORT_KIND_UNAVAILABLE` | `plant_report` | the objects come from a gap not installed | install / use the sibling gap |
| `DAT_COLUMN_UNKNOWN` | table / report | column not a property of the class | `plant_data_table` → `columns` |
| `DAT_IMPORT_FORMAT` / `DAT_IMPORT_KEY_MISSING` / `DAT_IMPORT_UNKNOWN_OBJECT` / `DAT_IMPORT_UNKNOWN_COLUMN` / `DAT_IMPORT_READONLY_COLUMN` / `DAT_IMPORT_TYPE` / `DAT_IMPORT_FORMULA` / `DAT_IMPORT_STALE` | `import_plant_data`, `import_tag_list` | §5.11 | per row / column |
| `DAT_RENUMBER_RANGE` | `renumber_tags` | range exceeds the padding width | widen the format or start lower |
| `DAT_IFC_MAPPING_MISSING` | `export_ifc` (warning in data) | class without IFC mapping → proxy | add `ifc` to the class |
| `DAT_IFC_PARSE` | `ifc_summary` | not ISO 10303-21 or unsupported schema | check the file header |
| `DAT_IDS_PARSE` / `DAT_IDS_UNSUPPORTED_FACET` | `check_ifc_requirements` | invalid IDS / facet not implemented | — |
| `DAT_STATUS_TRANSITION` | `set_deliverable_status` | illegal transition | follow §5.14 order |
| `DAT_HUMAN_GATE` / `DAT_SIGNATURE_INVALID` / `DAT_CHECK_FAILED` | idem | agent caller or missing / invalid signature; failing check | ask the qualified reviewer; fix the findings |
| `DAT_HANDOVER_MAPPING_MISSING` | `export_handover` | class without an external id in the profile | add `externalIds` |

## 8. Performance and robustness budgets

Target hardware: the CI runner class used by `npm run quality`. Values to be measured by VC-DAT-17 (`vitest bench`);
the budgets below are the acceptance thresholds.

| Operation | Size | Budget |
| --------- | ---- | ------ |
| `assign_plant_object` / `set_plant_properties` batch | 10 000 edits in one batch | < 1 s, one feature step |
| tag registry rebuild | 50 000 objects | < 200 ms |
| `plant_report` (any kind) JSON + CSV | 20 000 objects | < 1 s |
| XLSX write | 20 000 rows × 20 columns | < 3 s, < 15 MB |
| XLSX read + diff (V1) | same file | < 5 s |
| `export_ifc` IFC4X3 with ports | 2 000 lines, 20 000 products, 40 000 ports | < 15 s, linear in products |
| `ifc_summary` | 100 MB IFC text | < 20 s, streaming tokenizer, memory < 4× file size |
| `check_plant_data` | 50 000 objects | < 1 s |

Robustness: every query output is bounded by the CLI / MCP cap; large tables page (`offset`, `limit`) and files go
through `--save` (AF-12). Imports never apply a half-valid batch. A corrupt XLSX or IFC returns a code, never throws
(`CMD_THREW` is a test failure).

## 9. Test strategy (mapped to VCs)

| Test | Kind | VCs |
| ---- | ---- | --- |
| `tests/unit/plant/data/tagFormat.test.ts` | grammar, generation, regex, uniqueness from `tag_format_cases.json` | 01, 02 |
| `tests/unit/plant/data/reports.test.ts` | line list, equipment list, nozzle schedule, valve list, tag register, MTO against `sc_dat_01_reports_expected.json` | 03, 04, 05 |
| `tests/unit/plant/exchange/ifc4x3.test.ts` | export of SC-DAT-01 / 02 parsed with `stepRead`: counts, PredefinedTypes, `Tag`, nests, SOURCE → SINK, open ports vs `*.stats.json`; `CorrectPredefinedType` emulation (USERDEFINED ⇒ ObjectType) | 07, 08 |
| production oracle (`tests/production/oracle/ifc.ts` + optional `python3 -m ifcopenshell.validate --rules`) | schema + EXPRESS rules on the exported file; skipped with reason when Python / IfcOpenShell is absent | 06 |
| `tests/unit/plant/exchange/ids.test.ts` | IDS checker parity with `ids_results.json` on the five IFC files | 10 |
| `tests/golden/plant-data-sc-dat-01` | `build_project` plan → id-normalised snapshot; export twice byte-identical; replay equality | 11 |
| `tests/unit/plant/data/check.test.ts` | SC-DAT-03 codes, ids, paths | 12 |
| `tests/unit/plant/exchange/ifcSummary.test.ts` | bSI samples vs `bsi_sample_stats.json`; an IfcOpenShell-style reciprocal pair counts as one physical connection | 13 |
| `tests/unit/plant/data/properties.test.ts` | batch atomicity, `is pure`, undo | 14 |
| `tests/unit/plant/data/roundTrip.test.ts` | XLSX write read back = fixture cells; preview / apply of the edited fixture | 09 |
| `tests/unit/plant/data/deliverables.test.ts` | status machine, agent refusal, signature via a test `HumanSignaturePort` | 15 |
| `tests/unit/plant/exchange/handover.test.ts` | row counts, `unverified` | 16 |
| `tests/unit/plant/data/tagList.test.ts` | tag-list import, renumbering, provenance propagation | 18 |
| `reports.test.ts` (custom columns) | `=expr` columns with the existing evaluator | 19 |
| `tests/unit/plant/scenarioPlans.test.ts` | runs `validation/plans/*.json` steps not flagged `unbuilt` today, all steps once built | all |
| `tests/unit/contract/toolSchemas` snapshot | new tools and the `export_ifc` `schema` param | — |
| `tests/perf/plantData.bench.ts` | §8 budgets | 17 |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/**` (non-negotiable 3).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 data core | model, validate, hierarchy, classes + default library, tag formats, registry, `assign_plant_object`, `set_plant_properties`, `plant_data_table`, `check_plant_data` (MVP rules) | — | 2.5 weeks |
| M2 reports | line list, equipment list, nozzle schedule (inferred), tag register, MTO (centreline), CSV; `@lib` crc32 / zipWrite / xlsxWrite; `export_plant_data` | M1 | 1.5 weeks |
| M3 IFC 4.3 | `schema` param, hierarchy, class mapping, decomposition + ports + connections + systems, units + Psets, `Tag` in IFC4 too; `stepRead` promoted; production-oracle Python hook | M1 | 2.5 weeks |
| M4 round trip + checks | inflate, xlsxRead, `import_plant_data`, `import_tag_list`, `renumber_tags`, report definitions, `ifc_summary`, `check_ifc_requirements` | M2, M3 | 3 weeks |
| M5 sibling hooks | providers for 03 EQP nozzles, 01/02 components (valve list, MTO with take-outs), 04 PID instruments (instrument index, reserved tags from P&ID) | siblings | 1.5 weeks (DAT side) |
| M6 issue + handover | `set_deliverable_status` (09 PLM pattern), `export_handover` with an unverified CFIHOS-like profile; V2 IFC import | M2, 09 PLM | 2 weeks |

Total DAT-side effort ≈ 13 weeks for one engineer-agent lane; M1–M3 (≈ 6.5 weeks) deliver the MVP.

Cross-gap contracts (by folder name):

- `01-piping-specs-catalog` (PSC): component catalogue ids, spec names, take-out lengths, IFC class hint per
  component type; DAT reads them through the `pipeComponent` provider.
- `02-spec-driven-routing` (RTE): pipe runs bound to lines, inline components with ports, connectivity graph; DAT
  exports its ports instead of the MVP decomposition when present.
- `03-parametric-equipment` (EQP): nozzle objects with DN, rating, flow direction; equipment families → classes.
- `04-pid-schematics` (PID): P&ID tags reserved in the registry; instrument objects; P&ID ↔ 3D consistency uses the
  registry as the shared key.
- `05-isometrics-fabrication` (ISO): spools (`IfcPipeSegment SPOOL` or `IfcElementAssembly`), per-iso BOM reuses
  the MTO engine.
- `07-pipe-stress-flexibility` (PST), `09-plant-visualization-review` (VIS), `10-pointcloud-brownfield` (SCN): read
  tags and line data; VIS colours by class / service from the class model.
- `06-plant-structures-access` (STA): structures keep the IFC4 building path; platforms gain tags only if classified.

## 11. Open questions / decisions needed

- **Q1** Default `tagScope`: per plant (assumed) or per project? Owner-operators with several plants on one site
  often require site-wide uniqueness.
- **Q2** IFC 4.3 hierarchy: export plant areas as `IfcFacilityPartCommon USERDEFINED` (assumed) or keep
  `IfcBuildingStorey` only for viewer compatibility? Needs a check in two common viewers.
- **Q3** Distillation columns and reactors: `IfcTank USERDEFINED 'COLUMN'` vs `IfcBuildingElementProxy` vs a
  `IfcDistributionFlowElement` subtype — no column enum exists in ADD2.
- **Q4** Pipe supports: keep proxy `PIPESUPPORT` or move to `IfcDiscreteAccessory` (`SHOE`, `BRACKET`, …).
- **Q5** XLSX inflate in `@lib` (pure, testable, ~300 lines) or in the host (`node:zlib`, smaller core)?
- **Q6** Deliverable status in DAT vs PLM items of 09 PLM: implement the DAT state machine now and migrate, or wait?
- **Q7** Connection relationships: one `IfcRelConnectsPorts` per connection (IFC concept text, assumed) or the
  reciprocal pair written by IfcOpenShell's API, for round-trip parity with Bonsai users?
- **Q8** Should `add_equipment` / `add_pipe_run` accept a `className` directly (one call instead of two), or stay
  geometry-only with classification as a separate step (assumed: separate; a convenience may come later)?
- **Q9** CFIHOS: obtain the IOGP release files (licence permitting) to turn the handover profile from `unverified`
  into a gated deliverable.

## 12. References

- [R1] ISO 16739-1:2024, Industry Foundation Classes (IFC) for data sharing in the construction and facility management industries — Part 1: Data schema — ISO — https://www.iso.org/standard/84123.html (accessed 2026-10)
- [R2] buildingSMART International, IFC4.3.x-development, commit 7256780b (IfcDistributionPort, IfcRelConnectsPorts, enumerations) — https://github.com/buildingSMART/IFC4.3.x-development (accessed 2026-10)
- [R3] IfcOpenShell 0.9.0.post1 (IFC4X3_ADD2 schema, validate --rules, api) — https://pypi.org/project/ifcopenshell/ (accessed 2026-10)
- [R4] ifctester 0.9.0 / buildingSMART IDS 1.0 — https://pypi.org/project/ifctester/ (accessed 2026-10)
- [R5] buildingSMART Sample-Test-Files, commit 80d976a9 — https://github.com/buildingSMART/Sample-Test-Files (accessed 2026-10)
- [R6] Autodesk, AutoCAD Plant 3D 2026 User's Guide, Data Manager export — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/GUID-C09E92A6-D79A-4E9C-871E-2D34326C6237.htm (accessed 2026-10, search extract)
- [R7] Autodesk, AutoCAD Plant 3D 2026 User's Guide, properties and tag formats — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/project_create_properties_wrkflw.htm (accessed 2026-10, search extract)
- [R8] AVEVA E3D Design documentation and E3D 2.1 Model Conversion User Guide — https://docs.aveva.com/bundle/e3d-design/page/994926.html, https://help.aveva.com/AVEVA_Everything3D/2.1/ModConv/ModConv2.03.5.html (accessed 2026-10, search extract)
- [R9] IOGP JIP36 CFIHOS — https://www.iogp.org/blog/news/year-of-renewal-for-cfihos/ (accessed 2026-10, search extract)
- [R10] ISO 15926 — https://en.wikipedia.org/wiki/ISO_15926 (accessed 2026-10, search extract)
- [R11] openpyxl 3.1.5 — https://pypi.org/project/openpyxl/ (accessed 2026-10)
- [R12] RFC 1951 DEFLATE Compressed Data Format Specification — https://www.rfc-editor.org/rfc/rfc1951 ; RFC 4180 CSV — https://www.rfc-editor.org/rfc/rfc4180 (cited by number; not fetched)
- [R13] llull source files listed in §1 (this repository)

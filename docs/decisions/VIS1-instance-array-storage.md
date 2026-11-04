# VIS1 — How a 10^6-instance plant document is stored and loaded

Status: accepted 2026-11-04 (plant 09 VIS-M8 V2, "the 08-DAT storage decision"; decided by the orchestrator under the owner's delegation
"long-term-best over cheap, record the decision"). First slice built in VIS-M8j (09 TECHNICAL_SPEC §12.18).

## Problem

The 09 spec (§5 streaming, VIS-M8 row) says "the document loads geometry-free first (prototype table + instance arrays)" and the row
depended on "the 08-DAT storage decision", which no document made. 08 stores plant data (`doc.plant.data`) per object id and says
nothing about how a million repeated parts are held. Today every instance is one `Entity` in `doc.entities` / `doc.order`.

## Measured today

Windows, this machine, node 24, `VIS_PERF=1 npx vitest run tests/unit/storageBaseline.perf.test.ts`, SYN-RACK-v1 built directly as entities.

|                                                                      | 10^5 (bays 437, 100 071 entities) | 10^6 (bays 4367, 1 000 037 entities) |
| -------------------------------------------------------------------- | --------------------------------- | ------------------------------------ |
| document in memory (heap above the ~250 MB test-runner baseline)     | +30 MB                            | +214 MB                              |
| `serializeDocument`                                                  | 165 ms, 23.0 MB                   | 2.15 s, 233.8 MB                     |
| `deserializeDocument` (parse + shape + value validation + restore)   | 1.1 s                             | **13.3 s**, heap 532 -> 1 180 MB     |
| `planSceneOf` (one `PlanInstance` object + 2 AABB arrays per entity) | 0.41 s, +28 MB                    | 2.7 s, +282 MB                       |

Everything that touches a document is O(entities): validation (most of the 13 s load), `order` repair, derived-entity filtering, every
`Object.values(doc.entities)` scan in a command, the CLI / live-sync JSON string (234 MB). A million Entities is a 0.2 - 1 GB object
graph before a single triangle exists, and 234 B of JSON per bolt that differs from its neighbour only in 6 numbers.

## Decision

1. **Instance arrays are a document slice, not Entities.** `CadDocument.instanceArrays?: Record<arrayId, InstanceArray>` (core, like
   `display` / `review`: absent until the first array command; additive; the format version stays 3). One `InstanceArray` = a prototype +
   a packed per-instance table: `{ id, name, componentId, layerId, color, materialId?, scale?, count, encoding, transforms }`,
   `transforms` = base64 of `count x 6` little-endian float64 `[x, y, z, rx, ry, rz]` (document units; rotation = the Euler XYZ of
   `BaseEntity.rotation`). 48 B per instance in memory, 64 B in the file. Per-instance class / colour / data columns are further optional
   packed columns (next steps), never objects.
2. **The prototype is an existing `Component`** (`doc.components`: entities in local coordinates). No new prototype table: planScene's
   prototype key, `instanceBoundsFromDoc`, `expandInstance`, glTF `EXT_mesh_gpu_instancing`, BOM and `explode_instance` already speak
   components. An array member is exactly an `InstanceEntity` of that component without the Entity object (tested equal: same AABB, same
   prototype key, same diagonal as the explicit entity).
3. **File format: the same single JSON `llull-document` v3 file; the packed columns are base64 strings inside the slice.** No binary
   sidecar section now. Every host path (CLI file ops, `POST /command load_document`, live-sync snapshot, hashing, desktop File menu,
   replay cache) moves the document as one JSON string; a second container changes all of them and the determinism story (a document hash
   is a hash of its JSON). 10^6 instances is 64 MB of base64 (vs 234 MB of Entity JSON) and one V8 string; `MAX_ARRAY_INSTANCES` = 4 x 10^6
   per array (a string stays far below V8's limit), enforced on load and in the command. `encoding: 'f64le-base64'` is a field of the
   record, so a later `f32le` / delta / sidecar-referenced encoding is one more value with no version bump; revisit the container when a
   document needs > 10^7 instances or a memory-mapped partial load. In memory the string stays a string (plain JSON data: `is pure`
   deep-compare, undo snapshots, live sync and hashing keep working); the decoded `Float64Array` is a memo keyed on the record object
   (`WeakMap`), so a document pays the decode once.
4. **Commands: generative params, stored result.** The creating command (`add_instance_array`) takes a small layout spec (a 3-D grid:
   origin, counts, steps, rotation) and writes the packed table. Params are tiny, so the feature step, the command log (live sync) and
   replay stay small and replay re-mints the identical array (deterministic, step-scoped id `arr-<step>.1`). Undo / redo is a pointer swap:
   documents share the unchanged slice by reference (L3). The array is immutable after creation; editing = re-running the step with new
   params (L8) or detaching members. Arrays a plugin writes from its own recipe (flange bolts, stud fields) are derived: omitted on save and
   re-derived on load like derived entities (later step), so a plant document stores the plant data and the recipe, not a million
   transforms. Explicit packed tables are stored only for data with no recipe (imports); they are never a command parameter (a 64 MB param
   would be duplicated into `featureHistory`).
5. **Identity.** A member id is `<arrayId>#<index>` (index into the packed table), stable for the life of the array because arrays are
   immutable; `instanceMemberId` / `parseInstanceMemberId` are the only code that builds or splits one. It is what `planScene`,
   `render_stats`, clash reports and picks show. `doc.selection` stays entity ids; array selection is a later step (selecting the array id
   selects the whole array, a pick carries the member id). Promotion: `detach_array_instances` (later) turns chosen members into real
   `instance` Entities with step-scoped ids and records them in a sorted `detached` list on the array, so the other ids never shift.
6. **Plant-data identity (08).** `doc.plant.data` is keyed by object id and stays sparse. An array is one object provider kind
   `instance_array` (TR-DAT-05, the registration point exists); a member is `{ kind: 'array_member', id: '<arrayId>#<i>' }` and carries a
   tag / properties only when someone assigned them (an override map of a few hundred rows), never one record per instance. Bulk
   assignment by index range is the 08 extension of `assign_plant_object`. Plant data therefore never forces promotion to an Entity.
7. **Streaming falls out of the form.** Load = parse + one O(n) typed scan (finite values, byte length), no per-instance object: the
   document is "geometry-free" by construction (prototype components + packed columns). The renderer reads the packed columns directly
   (columnar `PlanScene`, next step) and builds spatial tiles (octree cells <= 50 000 instances) as a derived index, never stored.
8. **Rejected.**
   (a) One Entity per instance with a geometry-free load path: keeps the 13 s validation, the 0.2 - 1 GB graph and the O(n) scan of every
   command; streaming would hide the cost, not remove it.
   (b) A binary sidecar in a new container now: ~25 % smaller than base64 JSON but breaks the one-string document contract of every host.
   Kept as the documented escape hatch.
   (c) Storing only the generator (grid spec) as the document truth: the cheapest file, but irregular layouts (imports, plugin output) need
   the explicit table anyway; one storage form beats two. A generator stays the command's input.
   (d) A new "prototype table" beside components: duplicates `Component` and every consumer of it.

## Interaction table

| Concern     | Rule                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 / L4     | only `add_instance_array` (and later detach) write the slice; no component builds one                                                                  |
| L3 purity   | new record; the input document and its slice are never mutated; the decode memo is read-only                                                           |
| L8 replay   | the step stores the layout params; replay regenerates the same bytes (tested)                                                                          |
| derived     | plugin-derived arrays are omitted on save and restored by the plugin (later); command arrays are stored                                                |
| live sync   | the command log carries params only; a snapshot (`load_document`) carries the packed string once                                                       |
| CLI         | `add_instance_array` and `render_stats` read / write the slice; the result never echoes the table (count + bounds only)                                |
| load safety | `instanceArrayProblems`: id pattern + reserved keys, component exists, count in [1, MAX], base64 length = 48 x count, every value finite, layer exists |

## Spec rows changed

- 09 TECHNICAL_SPEC VIS-M8 row: deps `08-DAT storage decision` -> `VIS1 storage decision (built: §12.18)`; streaming paragraph: "prototype
  table + instance arrays" is now components + `doc.instanceArrays` (this record).
- 08 TECHNICAL_SPEC TR-DAT-05 (object providers): new kinds `instance_array` and `array_member` (design only, built with plant-data bulk assignment).
- 08 data slice: no change; format version 3 unchanged (TR-DAT-02 additive rule).

## Next steps (not built; ordered)

1. Columnar `PlanScene` (Float64Array AABBs, typed prototype / class columns): removes the 280 MB / 2.7 s of per-instance `PlanInstance` objects at 10^6; viewport, `render_stats` and BVH packing read columns.
2. Viewport: draw array members from the packed table (`InstancedMesh` matrices straight from the decoded columns), picking by member id, array selection.
3. Per-instance columns (class index, colour index) and `detach_array_instances`; plugin-derived arrays omitted on save.
4. Streaming tiles (octree <= 50 000), prototype LOD by projected size, Hi-Z occlusion with one-frame latency, impostors, terrain / sky / sun.
5. `export_gltf` / `check_clashes` / BOM over arrays (glTF `EXT_mesh_gpu_instancing` maps one array to one node directly).

## Addendum (2026-11-04, from lane VIS-M8i): how planScene reads arrays

VIS-M8i measured `planScene` at 10^6 SYN-RACK after TypeScript optimisation: ~1.0 - 1.2 s first call (was 2.1 - 2.9 s); the rest is building
10^6 JS objects, and `JSON.stringify` of 10^6 entities alone is > 1 s, so marshalling the document to a Rust sidecar costs more than the
TypeScript pass. Typed storage is the path under 500 ms: a struct-of-arrays `PlanScene` (Float64Array AABBs `6 x n`, Uint32 prototype and
class columns, ids derived from `(arrayId, index)` on demand, no id string per instance) fed straight from the decoded transform table, with
the prototype corner set computed once per array. VIS-M8j keeps the `PlanInstance[]` shape (arrays expand into objects) so the viewport,
`render_stats` and the BVH packing do not change in this slice; the columnar scene is next step 1 and is what makes the typed table pay.

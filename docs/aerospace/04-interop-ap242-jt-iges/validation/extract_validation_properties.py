"""Extract CAx-IF geometric validation properties (GVP) embedded in ISO 10303-21 STEP files.

Stdlib-only, independent of OpenCascade and of llull: it reads the PROPERTY_DEFINITION records named
'geometric validation property' (CAx-IF Recommended Practices for Geometric and Assembly Validation
Properties) and resolves PROPERTY_DEFINITION_REPRESENTATION -> REPRESENTATION -> items:
  MEASURE_REPRESENTATION_ITEM('volume measure' | 'surface area measure' | 'wetted area measure', <MEASURE>(v), #unit)
  CARTESIAN_POINT('centre point', (x, y, z))
It also reports FILE_SCHEMA, the global length unit, a census of PMI / tessellation / B-rep / assembly
entity types (records instantiating the type, simple or complex), and how many 'pmi validation property' /
'attribute validation property' definitions the file carries.

These values are what the ORIGINATING CAD system wrote; a reader is expected to recompute them from the
geometry and compare (that is the CAx-IF round-trip check). Output: JSON on stdout.

Usage: python3 -I extract_validation_properties.py <file.stp> [<file.stp> ...]
"""

import hashlib
import json
import os
import re
import sys

RECORD = re.compile(r"#(\d+)\s*=\s*(.*?);\s*(?=#\d+\s*=|ENDSEC)", re.S)
REF = re.compile(r"#(\d+)")
NUM = r"[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?"


def records(text):
    data = text.split("DATA;", 1)[1] if "DATA;" in text else text
    data = re.sub(r"/\*.*?\*/", "", data, flags=re.S)
    return {int(m.group(1)): " ".join(m.group(2).split()) for m in RECORD.finditer(data)}


def entity_name(body):
    m = re.match(r"([A-Z0-9_]+)\s*\(", body)
    return m.group(1) if m else "(complex)"


def first_string(body):
    m = re.search(r"'((?:[^']|'')*)'", body)
    return m.group(1).replace("''", "'") if m else None


def strings(body):
    return [s.replace("''", "'") for s in re.findall(r"'((?:[^']|'')*)'", body)]


def length_unit(recs, text):
    for body in recs.values():
        if body.startswith("(") and "LENGTH_UNIT" in body:
            si = re.search(r"SI_UNIT\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.METRE\.\s*\)", body)
            if si:
                prefix = si.group(1).strip(".")
                return {"$": "m", "MILLI": "mm", "CENTI": "cm", "MICRO": "um"}.get(prefix, prefix + " m")
            conv = re.search(r"CONVERSION_BASED_UNIT\(\s*'([^']*)'", body)
            if conv:
                return conv.group(1).lower()
    return None


def schema(text):
    m = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'", text)
    return " ".join(m.group(1).split()) if m else None


PMI_TYPES = (
    "DATUM", "DATUM_FEATURE", "DATUM_SYSTEM", "DATUM_REFERENCE_COMPARTMENT", "PLACED_DATUM_TARGET_FEATURE",
    "DIMENSIONAL_SIZE", "DIMENSIONAL_LOCATION", "ANGULAR_SIZE", "ANGULAR_LOCATION",
    "GEOMETRIC_TOLERANCE", "FLATNESS_TOLERANCE", "POSITION_TOLERANCE", "PERPENDICULARITY_TOLERANCE",
    "PARALLELISM_TOLERANCE", "SURFACE_PROFILE_TOLERANCE", "LINE_PROFILE_TOLERANCE", "CYLINDRICITY_TOLERANCE",
    "CIRCULAR_RUNOUT_TOLERANCE", "TOTAL_RUNOUT_TOLERANCE", "ANGULARITY_TOLERANCE", "COAXIALITY_TOLERANCE",
    "CONCENTRICITY_TOLERANCE", "SYMMETRY_TOLERANCE", "STRAIGHTNESS_TOLERANCE", "ROUNDNESS_TOLERANCE",
    "PLUS_MINUS_TOLERANCE", "TOLERANCE_ZONE",
    "TESSELLATED_ANNOTATION_OCCURRENCE", "ANNOTATION_CURVE_OCCURRENCE", "DRAFT_MODEL", "CHARACTERIZED_OBJECT_AND_CHARACTERIZED_REPRESENTATION_AND_DRAUGHTING_MODEL_AND_REPRESENTATION",
    "COMPLEX_TRIANGULATED_SURFACE_SET", "TRIANGULATED_FACE", "TESSELLATED_SHELL", "TESSELLATED_SOLID",
    "ADVANCED_FACE", "MANIFOLD_SOLID_BREP", "NEXT_ASSEMBLY_USAGE_OCCURRENCE", "PRODUCT",
)


def census(recs):
    """Records instantiating each type (simple or as a partial of a complex instance), counted once per record."""
    counts = {}
    for body in recs.values():
        for name in set(re.findall(r"([A-Z][A-Z0-9_]*)\s*\(", body)):
            if name in PMI_TYPES:
                counts[name] = counts.get(name, 0) + 1
    return dict(sorted(counts.items()))


def analyse(path):
    raw = open(path, "rb").read()
    text = raw.decode("latin-1")
    recs = records(text)
    pdr = {}
    for rid, body in recs.items():
        if entity_name(body) == "PROPERTY_DEFINITION_REPRESENTATION":
            refs = [int(r) for r in REF.findall(body)]
            if len(refs) >= 2:
                pdr.setdefault(refs[0], []).append(refs[1])
    counts = {"geometric": 0, "pmi": 0, "attribute": 0}
    props = []
    for rid, body in sorted(recs.items()):
        if entity_name(body) != "PROPERTY_DEFINITION":
            continue
        name = (first_string(body) or "").lower()
        for key in counts:
            if name == f"{key} validation property":
                counts[key] += 1
        if name != "geometric validation property":
            continue
        desc = strings(body)[1] if len(strings(body)) > 1 else ""
        target = [int(r) for r in REF.findall(body)]
        target_kind = entity_name(recs.get(target[-1], "")) if target else None
        entry = {"propertyDefinition": f"#{rid}", "description": desc, "definitionTarget": target_kind, "values": []}
        for rep_id in pdr.get(rid, []):
            rep = recs.get(rep_id, "")
            for item_id in [int(r) for r in REF.findall(rep)]:
                item = recs.get(item_id, "")
                kind = entity_name(item)
                if kind == "MEASURE_REPRESENTATION_ITEM":
                    m = re.search(r"'([^']*)'\s*,\s*([A-Z_]+)\s*\(\s*(" + NUM + r")\s*\)", item)
                    if m:
                        entry["values"].append({"item": m.group(1), "measure": m.group(2), "value": float(m.group(3))})
                elif kind == "CARTESIAN_POINT":
                    m = re.search(r"'([^']*)'\s*,\s*\(\s*(" + NUM + r")\s*,\s*(" + NUM + r")\s*,\s*(" + NUM + r")\s*\)", item)
                    if m:
                        entry["values"].append({"item": m.group(1), "measure": "CARTESIAN_POINT", "value": [float(m.group(i)) for i in (2, 3, 4)]})
                elif kind == "VALUE_REPRESENTATION_ITEM":
                    m = re.search(r"'([^']*)'\s*,\s*([A-Z_]+)\s*\(\s*(" + NUM + r")\s*\)", item)
                    if m:
                        entry["values"].append({"item": m.group(1), "measure": m.group(2), "value": float(m.group(3))})
        props.append(entry)
    return {
        "file": os.path.basename(path),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "fileSchema": schema(text),
        "lengthUnit": length_unit(recs, text),
        "validationPropertyCounts": counts,
        "geometricValidationProperties": props,
        "entityCensus": census(recs),
    }


def main(paths):
    json.dump([analyse(p) for p in paths], sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])

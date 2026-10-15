#!/usr/bin/env python3
"""Census of semantic + graphical PMI in the NIST MBE PMI AP242 test files (gap GDT, VC-GDT-20..24).

Reads the 17 NIST AP242 STEP files of the NIST zip (CTC 01-05, FTC 06-11 incl. the tessellated FTC 08
variant, STC 06-10), verifies the zip and each member's sha256 against nist_pmi_files.json, parses the ISO 10303-21 DATA section with the standard library only, and
counts the AP242 PMI entity instances a future llull `import_step_pmi` must recover. Output:
nist_pmi_census.json (committed). The STEP files themselves are NOT committed (sizes 0.4-6.1 MB).

Usage:
    python3 -I generate_nist_pmi_census.py <NIST-PMI-STEP-Files.zip | dir-with-the-stp-files> [out.json]
    (download the zip from nist_pmi_files.json "zip.url" into a fresh empty directory first)

Counting rules (deterministic, documented so a TS port can reproduce them):
- one record `#n=...;` = one instance; a complex instance `#n=(A(...)B(...));` contributes every
  partial entity name A, B to `entityNames`, but counts once in the classified buckets below;
- a geometric tolerance = an instance whose names contain one of GT_TYPES; its characteristic is
  that name; `withDatumReference` / `withModifiers` / `withMaximumTolerance` / `unequallyDisposed`
  flags come from the partial names GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE etc.;
- modifier enumerations (.MAXIMUM_MATERIAL_REQUIREMENT. ...) are counted as literal tokens in
  GEOMETRIC_TOLERANCE_WITH_MODIFIERS / DATUM_REFERENCE_MODIFIER records and elsewhere (raw counts).
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))

GT_TYPES = (
    'ANGULARITY_TOLERANCE', 'CIRCULAR_RUNOUT_TOLERANCE', 'COAXIALITY_TOLERANCE', 'CONCENTRICITY_TOLERANCE',
    'CYLINDRICITY_TOLERANCE', 'FLATNESS_TOLERANCE', 'LINE_PROFILE_TOLERANCE', 'PARALLELISM_TOLERANCE',
    'PERPENDICULARITY_TOLERANCE', 'POSITION_TOLERANCE', 'ROUNDNESS_TOLERANCE', 'STRAIGHTNESS_TOLERANCE',
    'SURFACE_PROFILE_TOLERANCE', 'SYMMETRY_TOLERANCE', 'TOTAL_RUNOUT_TOLERANCE',
)
DIMENSION_TYPES = (
    'DIMENSIONAL_SIZE', 'DIMENSIONAL_SIZE_WITH_DATUM_FEATURE', 'ANGULAR_SIZE', 'DIMENSIONAL_LOCATION',
    'DIRECTED_DIMENSIONAL_LOCATION', 'ANGULAR_LOCATION', 'DIMENSIONAL_LOCATION_WITH_DATUM_FEATURE',
)
DATUM_TYPES = (
    'DATUM', 'DATUM_FEATURE', 'DATUM_SYSTEM', 'DATUM_REFERENCE_COMPARTMENT', 'DATUM_REFERENCE_ELEMENT',
    'DATUM_TARGET', 'PLACED_DATUM_TARGET_FEATURE', 'DATUM_REFERENCE_MODIFIER_WITH_VALUE',
)
TOLERANCE_TYPES = ('PLUS_MINUS_TOLERANCE', 'TOLERANCE_VALUE', 'LIMITS_AND_FITS', 'TOLERANCE_ZONE', 'PROJECTED_ZONE_DEFINITION',
                   'RUNOUT_ZONE_DEFINITION', 'NON_UNIFORM_ZONE_DEFINITION')
SHAPE_ASPECT_TYPES = ('ALL_AROUND_SHAPE_ASPECT', 'BETWEEN_SHAPE_ASPECT', 'COMPOSITE_GROUP_SHAPE_ASPECT', 'CENTRE_OF_SYMMETRY',
                      'COMPOSITE_SHAPE_ASPECT', 'CONTINUOUS_SHAPE_ASPECT', 'COMPOSITE_UNIT_SHAPE_ASPECT')
PRESENTATION_TYPES = (
    'ANNOTATION_PLANE', 'DRAUGHTING_CALLOUT', 'TESSELLATED_ANNOTATION_OCCURRENCE', 'ANNOTATION_CURVE_OCCURRENCE',
    'ANNOTATION_PLACEHOLDER_OCCURRENCE', 'ANNOTATION_PLACEHOLDER_OCCURRENCE_WITH_LEADER_LINE', 'ANNOTATION_TO_MODEL_LEADER_LINE',
    'DRAUGHTING_MODEL_ITEM_ASSOCIATION', 'DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER', 'CAMERA_MODEL_D3',
    'CAMERA_MODEL_D3_MULTI_CLIPPING', 'DRAUGHTING_MODEL',
)
MODIFIER_TOKENS = (
    'MAXIMUM_MATERIAL_REQUIREMENT', 'LEAST_MATERIAL_REQUIREMENT', 'RECIPROCITY_REQUIREMENT', 'FREE_STATE', 'TANGENT_PLANE',
    'STATISTICAL_TOLERANCE', 'SEPARATE_REQUIREMENT', 'COMMON_ZONE', 'EACH_RADIAL_ELEMENT', 'UNITED_FEATURE', 'ANY_CROSS_SECTION',
    'ASSOCIATED_MINMAX_FEATURE', 'ASSOCIATED_LEAST_SQUARE_FEATURE', 'MAJOR_DIAMETER', 'MINOR_DIAMETER', 'PITCH_DIAMETER',
    'LINE_ELEMENT', 'NOT_CONVEX', 'POINT_METHOD',
)

_NAME = re.compile(r'([A-Z][A-Z0-9_]*)\s*\(')


def _records(text: str):
    """Yield (id, body) for each `#n=body;` record of the DATA section; quoted strings may hold ';'."""
    start = text.find('DATA;')
    end = text.rfind('ENDSEC;')
    data = text[start + 5:end]
    buf: list[str] = []
    in_str = False
    i = 0
    while i < len(data):
        c = data[i]
        if c == "'":
            if in_str and i + 1 < len(data) and data[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_str = not in_str
        if c == ';' and not in_str:
            rec = ''.join(buf).strip()
            buf = []
            if rec.startswith('#') and '=' in rec:
                ident, body = rec.split('=', 1)
                yield ident.strip(), body.strip()
        else:
            buf.append(c)
        i += 1


def _strip_strings(body: str) -> str:
    return re.sub(r"'(?:[^']|'')*'", "''", body)


def _names(body: str) -> list[str]:
    """Entity names of an instance: one for a simple instance, the top-level partials for a complex one."""
    clean = _strip_strings(body)
    if not clean.startswith('('):
        m = _NAME.match(clean)
        return [m.group(1)] if m else []
    names: list[str] = []
    depth = 0
    token = ''
    for c in clean[1:-1] if clean.endswith(')') else clean[1:]:
        if c == '(':
            if depth == 0 and token.strip():
                names.append(token.strip())
            depth += 1
            token = ''
        elif c == ')':
            depth -= 1
            token = ''
        elif depth == 0:
            token += c
    return names


def census(raw: bytes) -> dict:
    text = raw.decode('latin-1')
    header_schema = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'", text)
    entity_names: Counter[str] = Counter()
    gt_characteristic: Counter[str] = Counter()
    gt_flags: Counter[str] = Counter()
    modifier_tokens: Counter[str] = Counter()
    instances = 0
    for _ident, body in _records(text):
        instances += 1
        names = _names(body)
        entity_names.update(names)
        name_set = set(names)
        gts = [n for n in names if n in GT_TYPES]
        if gts:
            gt_characteristic[gts[0]] += 1
            for flag, partial in (
                ('withDatumReference', 'GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE'),
                ('withModifiers', 'GEOMETRIC_TOLERANCE_WITH_MODIFIERS'),
                ('withMaximumTolerance', 'GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE'),
                ('withDefinedUnit', 'GEOMETRIC_TOLERANCE_WITH_DEFINED_UNIT'),
                ('withDefinedAreaUnit', 'GEOMETRIC_TOLERANCE_WITH_DEFINED_AREA_UNIT'),
                ('unequallyDisposed', 'UNEQUALLY_DISPOSED_GEOMETRIC_TOLERANCE'),
            ):
                if partial in name_set:
                    gt_flags[flag] += 1
        for token in MODIFIER_TOKENS:
            hits = len(re.findall(r'\.' + token + r'\.', _strip_strings(body)))
            if hits:
                modifier_tokens[token] += hits

    def pick(keys):
        return {k: entity_names[k] for k in keys if entity_names[k]}

    return {
        'schema': header_schema.group(1) if header_schema else None,
        'instances': instances,
        'geometricTolerances': {
            'total': sum(gt_characteristic.values()),
            'byCharacteristic': dict(sorted(gt_characteristic.items())),
            'flags': dict(sorted(gt_flags.items())),
        },
        'dimensions': pick(DIMENSION_TYPES),
        'datums': pick(DATUM_TYPES),
        'tolerances': pick(TOLERANCE_TYPES),
        'shapeAspects': pick(SHAPE_ASPECT_TYPES),
        'presentation': pick(PRESENTATION_TYPES),
        'modifierTokens': dict(sorted(modifier_tokens.items())),
    }


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def reader(source: str):
    """Return read(entry) -> bytes | None over the NIST zip (verified) or a plain directory."""
    if source.endswith('.zip'):
        with open(source, 'rb') as handle:
            blob = handle.read()
        archive = zipfile.ZipFile(io.BytesIO(blob))
        names = set(archive.namelist())
        return blob, (lambda entry: archive.read(entry['zipPath']) if entry['zipPath'] in names else None)

    def from_dir(entry):
        path = os.path.join(source, entry['file'])
        if not os.path.exists(path):
            return None
        with open(path, 'rb') as handle:
            return handle.read()

    return None, from_dir


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    folder = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'nist_pmi_census.json')
    with open(os.path.join(HERE, 'nist_pmi_files.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    result = {
        '$comment': 'Generated by generate_nist_pmi_census.py from the pinned NIST AP242 files (nist_pmi_files.json, NIST zip February 2026 update). Counts are '
                    'instance counts in the STEP DATA section (see the script docstring for the rules). Do not edit by hand.',
        'files': {},
    }
    failures = 0
    blob, read = reader(folder)
    if blob is not None and sha256(blob) != manifest['zip']['sha256']:
        print('zip sha256 mismatch (a newer NIST release?): members are still checked one by one', file=sys.stderr)
    for entry in manifest['files']:
        raw = read(entry)
        if raw is None:
            print(f"missing {entry['file']}", file=sys.stderr)
            failures += 1
            continue
        actual = sha256(raw)
        if actual != entry['sha256'] or len(raw) != entry['bytes']:
            print(f"sha256/size mismatch {entry['file']}: {actual}", file=sys.stderr)
            failures += 1
            continue
        result['files'][entry['id']] = {'file': entry['file'], 'sha256': actual, **census(raw)}
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, indent=1, sort_keys=False)
        handle.write('\n')
    print(f'wrote {out} ({len(result["files"])} files, {failures} failures)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())

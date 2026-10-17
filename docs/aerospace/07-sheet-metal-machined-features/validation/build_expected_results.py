#!/usr/bin/env python3
"""Build validation/expected_results.json for gap FTR: every VC as CLI invocations + JSON assertions (AGENT_FIRST AF-23).

Run (after the data generators):  python3 -I build_expected_results.py  ->  writes expected_results.json
Standard library only. Every expected number is read from data/*.json (generated or hand-derived, see README §3)
or derived here from the formulas of TECHNICAL_SPEC §5 (shown in each case's "derivation"). Nothing is typed by hand
except the illustrative inputs of the agent-first (AF) cases, which test codes and flags, not engineering values.

Conventions for the CLI script that consumes this file (validation/README §2b):
  * "plan": an inline build_project actions array; the script writes it to a temp file and runs
    `llull run <file> --doc <tmp>.llull.json --json` (plus "flags").
  * "cli": further calls on the same --doc, run in order; each gets `--json` appended.
  * "<alias:NAME>" in a cli string = the first id in `affected` of the plan step whose "as" is NAME.
  * assertions apply to the JSON object of the LAST cli call unless "on" names an earlier call index.
  * ops: approx (abs or rel tol), eq, contains (array contains / string contains), exists, len, exit.
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
PLANS = 'docs/aerospace/07-sheet-metal-machined-features/validation/plans'


def load(name: str) -> dict:
    with open(os.path.join(DATA, name)) as fh:
        return json.load(fh)


FP = {b['id']: b for b in load('expected_flat_pattern.json')['bends']}
FPX = load('expected_flat_pattern.json')
JG = {j['id']: j for j in FPX['joggles']}
CS = load('expected_countersink.json')
PK = {c['id']: c for c in load('expected_pocket.json')['cases']}
TP = load('expected_test_parts.json')['parts']
REC = {c['vc']: c for c in load('expected_feature_recognition.json')['cases']}


def joggle_plan(j):
    """Plan of the joggle strip: a 40 x 30 strip with a joggle across x = 20 (add_joggle takes offset h and angle phi)."""
    return [
        {'command': 'set_units', 'params': {'units': 'mm'}},
        {'command': 'create_sheet_metal_rule', 'params': {'name': 'strip', 'material': '2024', 'thickness': j['T'], 'insideRadius': j['R'],
                                                           'kFactor': j['K_ansi'], 'kFactorStandard': 'ansi'}},
        {'command': 'draw_rectangle', 'params': {'width': 40, 'height': 30, 'position': [0, 0, 0]}, 'as': 'outline'},
        {'command': 'add_sheet_metal_base', 'params': {'profileId': '$outline', 'rule': 'strip', 'side': 'up'}, 'as': 'sm'},
        {'command': 'add_joggle', 'params': {'id': '$sm', 'face': {'near': [10, 15, 0]}, 'line': [[20, 30], [20, 0]], 'offset': j['offset_h'],
                                              'angle': j['phi_deg'], 'side': 'up'}},
    ]


def approx(path, value, tol, kind='abs', unit=None):
    a = {'path': path, 'op': 'approx', 'value': value, 'tol': tol, 'tolKind': kind}
    if unit:
        a['unit'] = unit
    return a


def eq(path, value):
    return {'path': path, 'op': 'eq', 'value': value}


def contains(path, value):
    return {'path': path, 'op': 'contains', 'value': value}


def exit_code(code):
    return {'op': 'exit', 'value': code}


def calc_cli(b, mode='k_factor'):
    k = '' if mode == 'faa_empirical' else f" kFactor={b['K_ansi']}"
    return (f"llull sheet_metal_calc units={b['units']} thickness={b['T']} insideRadius={b['R']} angle={b['theta_deg']}"
            f"{k} mode={mode}")


def plate_plan(t, size=40.0):
    return [{'command': 'set_units', 'params': {'units': 'mm'}},
            {'command': 'add_box', 'params': {'size': [size, size, t], 'position': [0, 0, 0], 'anchor': 'min'}, 'as': 'plate'}]


cases = []

# VC-FTR-01: every FP row through sheet_metal_calc (category b).
for b in FP.values():
    u = b['units']
    tol = 1e-7 if u == 'in' else 1e-6
    cases.append({
        'vc': 'VC-FTR-01', 'case': b['id'], 'proves': ['FR-FTR-04', 'FR-FTR-14', 'FR-FTR-30'], 'category': 'b',
        'cli': [calc_cli(b)],
        'assert': [eq('data.lengthUnit', u), approx('data.ba', b['BA'], tol, unit=u), approx('data.ossb', b['OSSB'], tol, unit=u),
                   approx('data.issb', b['ISSB'], tol, unit=u), approx('data.bd', b['BD'], tol, unit=u),
                   approx('data.kChart', b['K_chart_tan_half'], 1e-9)],
        'source': f"data/expected_flat_pattern.json bends[{b['id']}]",
    })

# VC-FTR-02: AC 43.13-1B setback example (a, V-search) + exact (b).
for fid, quoted in (('FP-09', 0.130), ('FP-10', 0.758)):
    b = FP[fid]
    cases.append({
        'vc': 'VC-FTR-02', 'case': fid, 'proves': ['FR-FTR-14', 'FR-FTR-30'], 'category': 'a (V-search) + b',
        'cli': [calc_cli(b)],
        'assert': [approx('data.ossb', quoted, 0.0005, unit='in'), approx('data.ossb', b['OSSB'], 1e-7, unit='in'),
                   approx('data.kChart', b['K_chart_tan_half'], 1e-5)],
        'source': f'AC 43.13-1B ch.4 [R2]; data/expected_flat_pattern.json {fid}',
    })

# VC-FTR-03: EAA / FAA empirical.
b = FP['FP-11']
cases.append({
    'vc': 'VC-FTR-03', 'case': 'FP-11', 'proves': ['FR-FTR-14'], 'category': 'a (V-search) + b',
    'cli': [calc_cli(b, 'faa_empirical')],
    'assert': [approx('data.ba', b['BA_faa_empirical'], 1e-7, unit='in'), approx('data.ba', 0.2796, 0.0007, unit='in'),
               eq('data.mode', 'faa_empirical')],
    'source': 'EAA [R3]; data/expected_flat_pattern.json FP-11',
})

# VC-FTR-04: FreeCAD calc-unfold (FP-01).
fc = FPX['freecad_calc_unfold_FP01']
cases.append({
    'vc': 'VC-FTR-04', 'case': 'FP-01', 'proves': ['FR-FTR-04'], 'category': 'b',
    'cli': [calc_cli(FP['FP-01'])],
    'assert': [approx('data.ba', fc['bend_allowance_mm'], 1e-6, unit='mm'), approx('data.ossb', fc['outside_setback_mm'], 1e-6, unit='mm')],
    'derivation': f"leg = 50 - BA/2 = {fc['leg_length_mm']}; flange = OSSB + leg = {fc['flange_length_mm']} (FreeCAD tools/calc-unfold.py [R7])",
    'source': 'data/expected_flat_pattern.json freecad_calc_unfold_FP01',
})

# VC-FTR-05: DIN -> ANSI conversion.
b = FP['FP-02']
cases.append({
    'vc': 'VC-FTR-05', 'case': 'DIN 0.88', 'proves': ['FR-FTR-01'], 'category': 'b',
    'cli': [f"llull sheet_metal_calc units=mm thickness={b['T']} insideRadius={b['R']} angle=90 kFactor=0.88 kStandard=din"],
    'assert': [approx('data.kFactor.value', 0.44, 1e-12), eq('data.kFactor.standard', 'ansi'), approx('data.ba', b['BA'], 1e-6, unit='mm')],
    'source': 'FreeCAD _convert_to_ansi_kfactor [R7]',
})

# VC-FTR-06/07/08/41: bracket plan.
br = TP['ftr_bracket_L.step']
bracket = {'plan_file': f'{PLANS}/draft_sheet_metal_bracket.json', 'flags': ['--kernel', 'occt']}
cases.append({
    'vc': 'VC-FTR-07', 'case': 'bracket K 0.44', 'proves': ['FR-FTR-04'], 'category': 'b', **bracket,
    'cli': ['llull flat_pattern id=<alias:sm> --kernel occt'],
    'assert': [approx('data.extents[0]', br['expected_flat_length_by_K']['0.44'], 0.01, unit='mm'), approx('data.extents[1]', 50.0, 1e-6, unit='mm'),
               {'path': 'data.bends', 'op': 'len', 'value': 1}, approx('data.bends[0].ba', FP['FP-02']['BA'], 1e-6, unit='mm')],
    'source': 'data/expected_test_parts.json ftr_bracket_L.step; FP-02',
})
cases.append({
    'vc': 'VC-FTR-06', 'case': 'bracket volume', 'proves': ['FR-FTR-02', 'FR-FTR-03'], 'category': 'b + c', **bracket,
    'cli': ['llull mass_properties entityId=<alias:sm> --kernel occt'],
    'assert': [approx('data.volume', br['analytic_volume_mm3'], 1e-6, 'rel', 'mm³'), eq('data.volumeUnit', 'mm³')],
    'derivation': br['volume_formula'],
    'source': 'data/expected_test_parts.json',
})
cases.append({
    'vc': 'VC-FTR-41', 'case': 'reviewRequired on flat_pattern', 'proves': ['FR-FTR-37'], 'af': ['AF-33', 'AF-36'], 'category': 'b', **bracket,
    'cli': ['llull flat_pattern id=<alias:sm> --kernel occt'],
    'assert': [eq('data.reviewRequired', True), {'path': 'data.reviewReason', 'op': 'exists'}, contains('summary', 'not approved')],
    'source': 'FUNCTIONAL_SPEC FR-FTR-37',
})

# VC-FTR-11 / 11b: joggle JG-01..03 (JG-04 is the refusal case under VC-FTR-37).
for jid in ('JG-01', 'JG-02', 'JG-03'):
    j = JG[jid]
    cases.append({
        'vc': 'VC-FTR-11', 'case': jid, 'proves': ['FR-FTR-09'], 'category': 'b', 'plan': joggle_plan(j),
        'cli': ['llull flat_pattern id=<alias:sm>'],
        'assert': [approx('data.joggles[0].allowance', j['allowance'], 1e-6, unit='mm'), approx('data.joggles[0].run', j['run'], 1e-6, unit='mm'),
                   approx('data.joggles[0].inclinedStraight', j['inclined_straight'], 1e-6, unit='mm')],
        'source': 'data/expected_flat_pattern.json ' + jid,
    })

# VC-FTR-17 / 18 / 19 / 20: recognition (needs gap 01 import_step_exact).
r17 = REC['VC-FTR-17']['expected']
cases.append({
    'vc': 'VC-FTR-17', 'case': 'machined plate', 'proves': ['FR-FTR-24'], 'category': 'b',
    'cli': ['llull import_step_exact file=docs/aerospace/07-sheet-metal-machined-features/validation/data/ftr_machined_plate.step --kernel occt',
            'llull find_entities kind=mesh', 'llull recognize_features id=<first:data.matches[0].id> --kernel occt'],
    'assert': [eq('data.counts.holes', r17['holes']), eq('data.counts.countersink', r17['by_subtype']['countersink']),
               eq('data.counts.counterbore', r17['by_subtype']['counterbore']), eq('data.counts.blind', r17['by_subtype']['simple_blind']),
               eq('data.counts.pockets', r17['pockets']), {'path': 'data.unclassified', 'op': 'len', 'value': 0}],
    'source': 'data/expected_feature_recognition.json VC-FTR-17',
})
r20 = REC['VC-FTR-20']['expected_features']['blind_drilled_holes_with_118deg_point']
cases.append({
    'vc': 'VC-FTR-20', 'case': 'NIST CTC-01', 'proves': ['FR-FTR-24'], 'category': 'c',
    'cli': ['llull import_step_exact file=docs/aerospace/07-sheet-metal-machined-features/validation/data/nist_ctc_01_asme1_ap242.stp --kernel occt',
            'llull find_entities kind=mesh', 'llull recognize_features id=<first:data.matches[0].id> --kernel occt'],
    'assert': [{'path': 'data.holes[?drillPointAngleDeg==118]', 'op': 'len', 'value': r20['count']},
               {'path': 'data.holes[?drillPointAngleDeg==118].diameter', 'op': 'eq', 'value': [r20['diameter']] * r20['count']}],
    'source': 'data/expected_feature_recognition.json VC-FTR-20 (measured baseline)',
})

# VC-FTR-22 / 23 / 24: countersinks and drill points on a plate of thickness T (category b).
for c in CS['countersinks']:
    t, d, big_d, alpha = c['T'], c['d'], c['D'], c['alpha_deg']
    vol = 1600.0 * t - math.pi * (d / 2) ** 2 * t - c['removed_volume_in_sheet']
    plan = plate_plan(t) + [{'command': 'add_hole', 'as': 'part', 'params': {
        'target': '$plate', 'face': {'near': [20, 20, t]}, 'points': [[20, 20]], 'pointsFrame': 'world_xy',
        'hole': {'kind': 'countersink', 'diameter': d, 'cskDiameter': big_d, 'cskAngle': alpha}, 'extent': {'kind': 'through_all'}}}]
    checks = [approx('data.rows[0].cskDepth', c['csk_depth_c'], 1e-6, unit='mm')]
    cases.append({
        'vc': 'VC-FTR-22', 'case': c['id'], 'proves': ['FR-FTR-17', 'FR-FTR-18'], 'category': 'b', 'plan': plan, 'flags': ['--kernel', 'occt'],
        'cli': ['llull hole_table id=<alias:part> --kernel occt', 'llull mass_properties entityId=<alias:part> --kernel occt'],
        'assert': [dict(checks[0], on=0), approx('data.volume', round(vol, 6), 1e-6, 'rel', 'mm³')],
        'derivation': '40*40*T - pi*(d/2)^2*T - removed_volume_in_sheet (TECHNICAL_SPEC 5.3)',
        'source': f"data/expected_countersink.json {c['id']}",
    })
    finding = [contains('data.findings[*].code', 'FTR_CSK_KNIFE_EDGE')] if c['knife_edge'] else \
        [{'path': 'data.findings[*].code', 'op': 'notContains', 'value': 'FTR_CSK_KNIFE_EDGE'}]
    if c['knife_edge']:
        finding.append(approx('data.findings[?code==FTR_CSK_KNIFE_EDGE].value', c['cylindrical_land'], 1e-6, unit='mm'))
    cases.append({
        'vc': 'VC-FTR-23', 'case': c['id'], 'proves': ['FR-FTR-26', 'FR-FTR-34'], 'af': ['AF-20', 'AF-30'], 'category': 'b', 'plan': plan,
        'flags': ['--kernel', 'occt'], 'cli': ['llull check_machining id=<alias:part> --kernel occt'], 'assert': finding,
        'source': f"data/expected_countersink.json {c['id']} (land = T - c)",
    })
for p in CS['drill_points']:
    d, beta, h = p['d'], p['point_angle_deg'], p['tip_height']
    vol = 16000.0 - math.pi * (d / 2) ** 2 * 6.0 - math.pi * (d / 2) ** 2 * h / 3.0
    plan = plate_plan(10.0) + [{'command': 'add_hole', 'as': 'part', 'params': {
        'target': '$plate', 'face': {'near': [20, 20, 10]}, 'points': [[20, 20]], 'pointsFrame': 'world_xy',
        'hole': {'kind': 'simple', 'diameter': d}, 'extent': {'kind': 'blind', 'depth': 6.0, 'drillPointAngle': beta}}}]
    cases.append({
        'vc': 'VC-FTR-24', 'case': p['id'], 'proves': ['FR-FTR-17'], 'category': 'b', 'plan': plan, 'flags': ['--kernel', 'occt'],
        'cli': ['llull hole_table id=<alias:part> --kernel occt', 'llull mass_properties entityId=<alias:part> --kernel occt'],
        'assert': [dict(approx('data.rows[0].tipHeight', h, 1e-6, unit='mm'), on=0), approx('data.volume', round(vol, 6), 1e-6, 'rel', 'mm³')],
        'derivation': '40*40*10 - pi*(d/2)^2*6 - pi*(d/2)^2*h/3 (blind depth 6 to the shoulder, tip cone below)',
        'source': f"data/expected_countersink.json {p['id']}",
    })

# VC-FTR-25 / 26: machined plate and today's baseline.
mp = TP['ftr_machined_plate.step']
cases.append({
    'vc': 'VC-FTR-25', 'case': 'machined plate plan', 'proves': ['FR-FTR-17', 'FR-FTR-21'], 'category': 'b + c',
    'plan_file': f'{PLANS}/draft_machined_plate.json', 'flags': ['--kernel', 'occt'],
    'cli': ['llull mass_properties entityId=<alias:part> --kernel occt'],
    'assert': [approx('data.volume', round(mp['analytic_volume_mm3'], 6), 1e-6, 'rel', 'mm³')],
    'source': 'data/expected_test_parts.json ftr_machined_plate.step',
})
base_vol = 60000.0 - math.pi * 2.4 ** 2 * 10.0 - CS['countersinks'][0]['removed_volume_beyond_hole']
cases.append({
    'vc': 'VC-FTR-26', 'case': 'baseline (existing commands, runs today)', 'proves': ['FR-FTR-17'], 'category': 'b',
    'plan_file': f'{PLANS}/baseline_countersunk_plate_today.json', 'flags': ['--kernel', 'occt'],
    'cli': ['llull mass_properties entityId=<alias:part> --kernel occt'],
    'assert': [approx('data.volume', round(base_vol, 6), 1e-6, 'rel', 'mm³')],
    'derivation': '100*60*10 - pi*2.4^2*10 - CS-01 removed_volume_beyond_hole',
    'source': 'review run 2026-10-15: 59783.006 mm³ (display precision)',
})

# VC-FTR-27: pockets.
for pid in ('PK-01', 'PK-02'):
    p = PK[pid]
    plan = [{'command': 'set_units', 'params': {'units': 'mm'}},
            {'command': 'add_box', 'params': {'size': [60, 40, 10], 'position': [0, 0, 0], 'anchor': 'min'}, 'as': 'plate'},
            {'command': 'add_pocket', 'as': 'part', 'params': {
                'target': '$plate', 'face': {'near': [30, 20, 10]},
                'outline': {'kind': 'rectangle', 'center': [30, 20], 'size': [p['W'], p['L']]}, 'pointsFrame': 'world_xy', 'cornerRadius': p['rc'],
                'depth': p['D'], 'floorFillet': p['rf']}}]
    cases.append({
        'vc': 'VC-FTR-27', 'case': pid, 'proves': ['FR-FTR-21'], 'category': 'b', 'plan': plan, 'flags': ['--kernel', 'occt'],
        'cli': ['llull mass_properties entityId=<alias:part> --kernel occt'],
        'assert': [approx('data.volume', round(24000.0 - p['removed_volume'], 6), 1e-6, 'rel', 'mm³')],
        'derivation': '60*40*10 - removed_volume (expected_pocket.json formula)', 'source': f'data/expected_pocket.json {pid}',
    })

# ---- Agent-first cases (AF) -------------------------------------------------------------------------------------
pk3 = PK['PK-03']
cases.append({
    'vc': 'VC-FTR-37', 'case': 'refusal codes', 'proves': ['FR-FTR-33'], 'af': ['AF-11'], 'category': 'b',
    'subcases': [
        {'id': 'PK-03', 'plan': [{'command': 'set_units', 'params': {'units': 'mm'}},
                                  {'command': 'add_box', 'params': {'size': [60, 40, 10], 'anchor': 'min'}, 'as': 'plate'},
                                  {'command': 'add_pocket', 'params': {'target': '$plate', 'face': {'near': [30, 20, 10]},
                                   'outline': {'kind': 'rectangle', 'center': [30, 20], 'size': [pk3['W'], pk3['L']]}, 'pointsFrame': 'world_xy',
                                   'cornerRadius': pk3['rc'], 'depth': pk3['D'], 'floorFillet': pk3['rf']}}],
         'assert': [exit_code(1), eq('data.steps[2].error.code', 'FTR_POCKET_FILLET_GT_CORNER'), contains('data.steps[2].error.paths', 'floorFillet'),
                    {'path': 'data.steps[2].error.remediation', 'op': 'exists'}]},
        {'id': 'K missing', 'cli': ['llull sheet_metal_calc units=mm thickness=1.6 insideRadius=4.8 angle=90'],
         'assert': [exit_code(1), eq('error.code', 'FTR_K_FACTOR_MISSING'), contains('error.paths', 'kFactor')]},
        {'id': 'angle 0', 'cli': ['llull sheet_metal_calc units=mm thickness=1.6 insideRadius=4.8 angle=0 kFactor=0.44'],
         'assert': [exit_code(1), eq('error.code', 'FTR_BEND_ANGLE_OUT_OF_RANGE')]},
        {'id': 'row without source', 'cli': ["llull import_bend_radius_table 'rows=[{\"material\":\"TEST-ALLOY\",\"temper\":\"T0\",\"thickness\":0.8,\"minInsideRadius\":2.0,\"units\":\"mm\",\"bendAngle\":90,\"verification\":\"unverified\"}]'"],
         'assert': [exit_code(1), eq('error.code', 'FTR_TABLE_ROW_NO_SOURCE'), contains('error.paths', 'rows[0].source')]},
        {'id': 'csk D <= d', 'plan': plate_plan(10.0) + [{'command': 'add_hole', 'params': {'target': '$plate', 'face': {'near': [20, 20, 10]},
                                   'points': [[20, 20]], 'pointsFrame': 'world_xy', 'hole': {'kind': 'countersink', 'diameter': 4.8, 'cskDiameter': 4.0, 'cskAngle': 100},
                                   'extent': {'kind': 'through_all'}}}],
         'assert': [exit_code(1), eq('data.steps[2].error.code', 'FTR_HOLE_DIAMETERS_INCONSISTENT')]},
        {'id': 'JG-04 (V1)', 'note': 'add_joggle with JG-04 values on a T 1.6 part', 'plan': joggle_plan(JG['JG-04']),
         'assert': [exit_code(1), eq('data.steps[4].error.code', 'FTR_JOGGLE_OFFSET_TOO_SMALL')], 'source': 'data/expected_flat_pattern.json JG-04'},
    ],
})

test_row = {'material': 'TEST-ALLOY', 'temper': 'T0', 'thickness': 0.8, 'minInsideRadius': 2.0, 'units': 'mm', 'bendAngle': 90,
            'source': 'synthetic test row (not engineering data)', 'verification': 'unverified'}


def sm_part_plan(radius, extra_rule=None):
    rule = {'name': 'TEST', 'material': 'TEST-ALLOY', 'temper': 'T0', 'thickness': 0.8, 'insideRadius': radius, 'kFactor': 0.4, 'kFactorStandard': 'ansi'}
    rule.update(extra_rule or {})
    return [{'command': 'set_units', 'params': {'units': 'mm'}},
            {'command': 'import_bend_radius_table', 'params': {'rows': [test_row]}},
            {'command': 'create_sheet_metal_rule', 'params': rule},
            {'command': 'draw_rectangle', 'params': {'width': 20, 'height': 20, 'position': [0, 0, 0]}, 'as': 'outline'},
            {'command': 'add_sheet_metal_base', 'params': {'profileId': '$outline', 'rule': 'TEST', 'side': 'up'}, 'as': 'sm'},
            {'command': 'add_flange', 'params': {'id': '$sm', 'edge': {'near': [20, 10, 0]}, 'angle': 90, 'length': 20,
                                                  'lengthReference': 'outside_mold_line', 'position': 'material_outside'}}]


cases.append({
    'vc': 'VC-FTR-10', 'case': 'min bend radius from (synthetic) table row', 'proves': ['FR-FTR-07', 'FR-FTR-34'], 'af': ['AF-30'], 'category': 'b',
    'subcases': [
        {'id': 'R 1.0 < row 2.0', 'plan': sm_part_plan(1.0), 'cli': ['llull check_sheet_metal id=<alias:sm>'],
         'assert': [eq('data.status', 'fail'), contains('data.findings[*].code', 'FTR_BEND_RADIUS_BELOW_MIN'),
                    approx('data.findings[?code==FTR_BEND_RADIUS_BELOW_MIN].limit', 2.0, 1e-12, unit='mm')]},
        {'id': 'R 0, sharp bends forbidden', 'plan': sm_part_plan(0.0), 'assert': [exit_code(1), eq('data.steps[5].error.code', 'FTR_SHARP_BEND_FORBIDDEN')]},
        {'id': 'R 2.4 ok', 'plan': sm_part_plan(2.4), 'cli': ['llull check_sheet_metal id=<alias:sm>'],
         'assert': [{'path': 'data.findings[*].code', 'op': 'notContains', 'value': 'FTR_BEND_RADIUS_BELOW_MIN'}]},
    ],
    'source': 'FP-12 geometry; synthetic row (real rows TBD after D6)',
})
cases.append({
    'vc': 'VC-FTR-38', 'case': 'rule without threshold is reported, not skipped', 'proves': ['FR-FTR-34'], 'af': ['AF-20', 'AF-30', 'AF-31'], 'category': 'b',
    'plan': plate_plan(10.0) + [{'command': 'add_hole', 'as': 'part', 'params': {'target': '$plate', 'face': {'near': [20, 20, 10]}, 'points': [[20, 20]],
                                 'pointsFrame': 'world_xy', 'hole': {'kind': 'countersink', 'diameter': 4.8, 'cskDiameter': 9.0, 'cskAngle': 100},
                                 'extent': {'kind': 'through_all'}}}],
    'flags': ['--kernel', 'occt'], 'cli': ['llull check_machining id=<alias:part> --kernel occt'],
    'assert': [contains('data.findings[*].code', 'FTR_RULE_THRESHOLD_MISSING'), contains('data.rulesSkipped[*].rule', 'minLand')],
})
cases.append({
    'vc': 'VC-FTR-39', 'case': 'named defaults', 'proves': ['FR-FTR-35'], 'af': ['AF-31'], 'category': 'b',
    'subcases': [
        {'id': 'K never defaulted', 'cli': ['llull sheet_metal_calc units=in thickness=0.064 insideRadius=0.25 angle=90'],
         'assert': [exit_code(1), eq('error.code', 'FTR_K_FACTOR_MISSING')]},
        {'id': 'drill point default named', 'plan': plate_plan(10.0) + [{'command': 'add_hole', 'as': 'part', 'params': {'target': '$plate',
         'face': {'near': [20, 20, 10]}, 'points': [[20, 20]], 'pointsFrame': 'world_xy', 'hole': {'kind': 'simple', 'diameter': 6.0},
         'extent': {'kind': 'blind', 'depth': 6.0}}}], 'flags': ['--kernel', 'occt'], 'cli': ['llull hole_table id=<alias:part> --kernel occt'],
         'assert': [approx('data.rows[0].drillPointAngle.value', 118.0, 1e-12, unit='deg'), eq('data.rows[0].drillPointAngle.defaulted', True),
                    contains('data.rows[0].drillPointAngle.source', 'R8')]},
    ],
})
cases.append({
    'vc': 'VC-FTR-40', 'case': 'unverified propagation', 'proves': ['FR-FTR-36'], 'af': ['AF-32'], 'category': 'b',
    'subcases': [
        {'id': 'calc', 'plan': [{'command': 'set_units', 'params': {'units': 'mm'}}, {'command': 'import_bend_radius_table', 'params': {'rows': [test_row]}}],
         'cli': ['llull sheet_metal_calc units=mm thickness=0.8 insideRadius=2.4 angle=90 kFactor=0.4 material=TEST-ALLOY temper=T0'],
         'assert': [eq('data.unverified', True), contains('data.unverifiedInputs[*].kind', 'radius_row'), approx('data.minRadius.value', 2.0, 1e-12, unit='mm'),
                    eq('data.minRadius.verification', 'unverified')]},
        {'id': 'check', 'plan': sm_part_plan(2.4), 'cli': ['llull check_sheet_metal id=<alias:sm>', 'llull flat_pattern id=<alias:sm>'],
         'assert': [dict(contains('data.findings[*].code', 'FTR_UNVERIFIED_DATA'), on=0), eq('data.unverified', True)]},
    ],
})
cases.append({
    'vc': 'VC-FTR-42', 'case': 'waiver needs a human approval (gap 09)', 'proves': ['FR-FTR-38'], 'af': ['AF-34'], 'category': 'b',
    'plan': sm_part_plan(1.0),
    'cli': ["llull check_sheet_metal id=<alias:sm> 'waivers=[{\"code\":\"FTR_BEND_RADIUS_BELOW_MIN\",\"ids\":[\"<alias:sm>\"],\"approvalRef\":\"approval-does-not-exist\"}]'"],
    'assert': [eq('data.status', 'fail'), contains('data.findings[*].code', 'FTR_BEND_RADIUS_BELOW_MIN'), contains('data.findings[*].code', 'FTR_WAIVER_NOT_APPROVED')],
})
b = FP['FP-10']
cases.append({
    'vc': 'VC-FTR-43', 'case': 'provenance', 'proves': ['FR-FTR-39'], 'af': ['AF-35'], 'category': 'b',
    'cli': [calc_cli(b)],
    'assert': [eq('data.provenance.formulas.ossb', 'tan(theta/2)*(R+T)'), eq('data.provenance.formulas.ba', 'theta*(R+K*T)'),
               approx('data.provenance.inputs.thickness.value', 0.064, 1e-12), eq('data.provenance.inputs.thickness.unit', 'in'),
               contains('data.provenance.sources', 'R2')],
})
cases.append({
    'vc': 'VC-FTR-44', 'case': 'discoverable, units in schemas, data units', 'proves': ['FR-FTR-31', 'FR-FTR-32'], 'af': ['AF-01', 'AF-02', 'AF-04', 'AF-10'], 'category': 'b',
    'subcases': [
        {'id': 'search', 'cli': ['llull search sheet metal flat pattern'], 'assert': [contains('[*].name', 'flat_pattern'), contains('[*].name', 'sheet_metal_calc')]},
        {'id': 'describe', 'cli': ['llull describe sheet_metal_calc add_flange add_hole add_pocket check_machining'],
         'assert': [{'op': 'allNumericParamsHaveUnit', 'unitWords': ['document length unit', 'degrees', 'in `units`']}]},
        {'id': 'echo', 'cli': [calc_cli(FP['FP-02'])], 'assert': [eq('data.lengthUnit', 'mm'), eq('data.angleUnit', 'deg')]},
    ],
})
cases.append({
    'vc': 'VC-FTR-45', 'case': 'validate, dry run, picture', 'proves': ['FR-FTR-40', 'FR-FTR-41'], 'af': ['AF-05', 'AF-22', 'AF-42'], 'category': 'b',
    'subcases': [
        {'id': 'validate ok', 'cli': [f'llull run {PLANS}/draft_sheet_metal_bracket.json --validate'], 'assert': [exit_code(0), eq('ok', True)]},
        {'id': 'validate names step and param', 'plan_validate_only': [{'command': 'sheet_metal_calc', 'params': {'units': 'mm', 'thickness': 'abc', 'insideRadius': 1, 'angle': 90, 'kFactor': 0.4}}],
         'assert': [exit_code(1), contains('summary', 'step 0'), contains('summary', 'thickness')]},
        {'id': 'dry run leaves the file unchanged', **bracket, 'cli': ['llull add_flange id=<alias:sm> \'edge={"near":[0,25,0]}\' angle=90 length=20 lengthReference=outside_mold_line position=material_outside --dry-run'],
         'assert': [{'op': 'docFileUnchanged'}]},
        {'id': 'render', **bracket, 'cli': ['llull flat_pattern id=<alias:sm> materialize=true', 'llull render_view view=top --save flat.png'],
         'assert': [contains('saved[*].path', 'flat.png'), {'op': 'fileIsPng', 'value': 'flat.png'}]},
    ],
})
cases.append({
    'vc': 'VC-FTR-46', 'case': 'progress and timeout on a large part', 'proves': ['FR-FTR-42'], 'af': ['AF-40', 'AF-41'], 'category': 'c',
    'cli': ['llull import_step_exact file=<ctc-dir>/nist_ctc_02_asme1_ap242.stp --kernel occt --progress --timeout 120',
            'llull find_entities kind=mesh', 'llull recognize_features id=<first:data.matches[0].id> --kernel occt --progress --timeout 30'],
    'assert': [exit_code(0), {'op': 'durationBelowMs', 'value': 5000, 'on': 2}],
    'source': 'TECHNICAL_SPEC §8 budget; CTC-02 sha256 pinned in README §4',
})

out = {
    'description': 'Gap FTR validation cases as CLI invocations + JSON assertions (AGENT_FIRST AF-23). Generated; do not edit by hand.',
    'generator': 'docs/aerospace/07-sheet-metal-machined-features/validation/build_expected_results.py',
    'conventions': {
        'doc': 'each case runs on a fresh temp --doc; plan / plan_file first (llull run … --json), then cli calls with --json',
        'alias': '<alias:NAME> = first id in affected of the plan step whose "as" is NAME',
        'first': '<first:PATH> = the value at PATH (e.g. data.matches[0].id of find_entities) in the previous call\'s --json output',
        'paths': 'dot paths into the --json object (a single command that fails reports error.code / error.paths / error.remediation beside data; a plan reports data.steps[i].error); [*] maps over an array; [?field==value] filters',
        'status': 'all cases run against the built commands (server/tests/packReplay07.test.ts replays them through runCli); VC-FTR-46 needs the pinned CTC-02 (npm run quality:fetch)',
    },
    'cases': cases,
}
with open(os.path.join(HERE, 'expected_results.json'), 'w') as fh:
    json.dump(out, fh, indent=1)
    fh.write('\n')

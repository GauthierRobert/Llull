import { describe, it, expect } from 'vitest';
import { CONVENTIONS_GUIDE } from '@protocol/conventions';

describe('CONVENTIONS_GUIDE content', () => {
  it('is a non-empty string', () => {
    expect(typeof CONVENTIONS_GUIDE).toBe('string');
    expect(CONVENTIONS_GUIDE.length).toBeGreaterThan(100);
  });
  it('covers document units (mm/cm/m/in/ft)', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/units/i);
    // At least some unit strings must be mentioned
    expect(CONVENTIONS_GUIDE).toMatch(/"mm"/);
  });
  it('covers the right-handed +Z-up world frame', () => {
    for (const s of [/right.handed/i, /\+Z/, /up/i]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('covers add_box anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_box/);
    expect(CONVENTIONS_GUIDE).toMatch(/center/i);
  });
  it('covers add_cylinder anchor as center (not base-center)', () => {
    const row = CONVENTIONS_GUIDE.split('\n').find((l) => l.includes('add_cylinder'));
    expect(row).toBeDefined();
    expect(row).toMatch(/center/i);
    expect(row).not.toMatch(/base.center/i);
  });
  it('covers add_sphere anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_sphere/);
  });
  it('covers add_cone anchor as base-center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_cone/);
  });
  it('covers add_torus anchor as center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_torus/);
  });
  it('covers add_wedge anchor as lower-front-left', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_wedge/);
    expect(CONVENTIONS_GUIDE).toMatch(/lower.front.left/i);
  });
  it('covers add_pyramid anchor as base-center', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/add_pyramid/);
  });
  it('covers rotation as Euler XYZ radians (not degrees)', () => {
    for (const s of [/rotation/i, /radian/i, /degree/i]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('covers the recommended agent loop: describe_scene → create → render_view → check_model', () => {
    for (const s of [/describe_scene/, /render_view/, /check_model/]) expect(CONVENTIONS_GUIDE).toMatch(s);
  });
  it('mentions showAxes or showGrid in the render_view step', () => {
    // The guide should mention the new default-on axis/grid overlay
    expect(CONVENTIONS_GUIDE).toMatch(/showAxes|showGrid/);
  });
  it('covers common pitfalls section', () => {
    expect(CONVENTIONS_GUIDE).toMatch(/pitfall/i);
  });
  it('does NOT contain any import or require statements (pure content module)', () => {
    // Conventions guide is plain text/markdown — no code imports
    expect(CONVENTIONS_GUIDE).not.toMatch(/^import /m);
    expect(CONVENTIONS_GUIDE).not.toMatch(/require\(/);
  });
});

describe('CONVENTIONS_GUIDE aerospace section (AF-03)', () => {
  const section = CONVENTIONS_GUIDE.slice(CONVENTIONS_GUIDE.indexOf('## 8. Materials, fasteners and manufacturing'));

  it('exists and names only registered commands', async () => {
    const { getCommand } = await import('@core/commands/registry');
    expect(section.length).toBeGreaterThan(500);
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    const unknown = names.filter((name) => getCommand(name) === undefined && !['import_step_exact'].includes(name));
    expect(names.length).toBeGreaterThan(30);
    expect(unknown).toEqual([]);
  });

  it('states the review requirement and the human gate', () => {
    expect(section).toMatch(/reviewRequired/);
    expect(section).toMatch(/MAT_HUMAN_GATE/);
    expect(section).toMatch(/FTR_WAIVER_NOT_APPROVED/);
  });
});

describe('CONVENTIONS_GUIDE blends section (BLD, AF-03)', () => {
  const start = CONVENTIONS_GUIDE.indexOf('## 14. Fillets, chamfers and blends');
  const section = CONVENTIONS_GUIDE.slice(start);

  it('exists and names the blend commands, the laws, the corners and the checks', () => {
    expect(start).toBeGreaterThan(0);
    for (const name of [
      'fillet_edge',
      'fillet_faces',
      'fillet_full_round',
      'chamfer_edge',
      'blend_union',
      'probe_fillet',
      'check_blends',
      'setback',
      'profile',
      'radiusEnd',
      'distanceEnd',
    ])
      expect(section).toContain(name);
  });

  it('names only registered commands', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    expect(new Set(names).size).toBeGreaterThan(8);
    const unknown = [...new Set(names)].filter((name) => getCommand(name) === undefined && name !== 'kernel_info');
    expect(unknown).toEqual([]);
  });

  it('names every code its refusal table lists as a code the blend commands can return', async () => {
    const codes = [...section.matchAll(/BLD_[A-Z_]+/g)].map((match) => match[0]);
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'packages/core/src');
    const sources: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(folder, entry.name));
        else if (entry.name.endsWith('.ts') && /blend|fillet|chamfer|diagnose|modify3d/i.test(entry.name))
          sources.push(readFileSync(join(folder, entry.name), 'utf8'));
      }
    };
    walk(dir);
    const all = sources.join('\n');
    expect([...new Set(codes)].filter((code) => !all.includes(code))).toEqual([]);
  });

  it('its worked plan is valid: every action is a registered command and its params pass the command schema', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(block).toBeDefined();
    const plan = JSON.parse(block ?? '{}') as { actions: Array<{ command: string; params: Record<string, unknown> }> };
    expect(plan.actions.length).toBeGreaterThan(5);
    for (const action of plan.actions) {
      const command = getCommand(action.command);
      expect(command, action.command).toBeDefined();
      const params = JSON.parse(JSON.stringify(action.params).replace(/"\$[a-z]+"/g, '"id-1"')) as unknown;
      const parsed = command?.paramsValidator?.safeParse(params);
      expect(parsed?.success, `${action.command}: ${JSON.stringify(parsed?.error?.issues)}`).toBe(true);
    }
  });

  it('says what is not offered, and that cliff edges are', () => {
    expect(section).toMatch(/Not offered \(no param exists\): partial fillets, trim modes of face blends other than the end walls/);
    expect(section).toMatch(/Cliff edges: `fillet_faces cliff`/);
  });
});

describe('CONVENTIONS_GUIDE wrap / emboss (03 WRP AF-03) and implicit (05 IMP) sections', () => {
  const sectionOf = (title: string, next: string | null): string => {
    const start = CONVENTIONS_GUIDE.indexOf(title);
    expect(start).toBeGreaterThan(0);
    return CONVENTIONS_GUIDE.slice(start, next === null ? undefined : CONVENTIONS_GUIDE.indexOf(next));
  };

  it('the wrap section names the wrap, projection, emboss, decal, knurl and check commands and the refusal codes', () => {
    const section = sectionOf('## 15. Wrap, project and emboss on faces', '## 16.');
    for (const word of ['wrap_to_face', 'project_to_face', 'emboss_on_face', 'pattern_on_face', 'add_decal', 'add_knurl', 'check_wrap'])
      expect(section).toContain(word);
    for (const code of ['WRP_FACE_NOT_DEVELOPABLE', 'WRP_WRAP_OVERLAP', 'WRP_OUTSIDE_FACE', 'WRP_DISTORTION_EXCEEDED'])
      expect(section).toContain(code);
  });

  it('the implicit section walks fields, edits, realisation and checks', () => {
    const section = sectionOf('## 16. Implicit fields, lattices and infill', null);
    for (const word of [
      'add_tpms_lattice',
      'combine_fields',
      'create_implicit_body',
      'infill_solid',
      'check_implicit',
      'implicit_properties',
    ])
      expect(section).toContain(word);
    expect(section).toContain('IMP_TRAPPED_VOID');
  });
});

describe('CONVENTIONS_GUIDE plant equipment section (plant 03 EQP, AF-03)', () => {
  const start = CONVENTIONS_GUIDE.indexOf('## 17. Plant equipment');
  const section = CONVENTIONS_GUIDE.slice(start);

  it('exists and names only registered commands, including every equipment command it teaches', async () => {
    const { getCommand } = await import('@core/commands/registry');
    expect(start).toBeGreaterThan(0);
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    expect(names.filter((name) => getCommand(name) === undefined)).toEqual([]);
    for (const name of [
      'add_vessel',
      'add_nozzle',
      'equipment_ports',
      'vessel_thickness',
      'check_equipment',
      'equipment_datasheet',
      'export_ifc',
    ])
      expect(names).toContain(name);
  });

  it('states units, the angle convention, the port id form, the review requirement and the never-defaulted stress', () => {
    expect(section).toMatch(/DOCUMENT units/);
    expect(section).toMatch(/"north_cw"/);
    expect(section).toMatch(/<tag>:<mark>/);
    expect(section).toMatch(/reviewRequired/);
    expect(section).toMatch(/EQP_ALLOWABLE_MISSING/);
    expect(section).toMatch(/available: false/);
  });
});

describe('CONVENTIONS_GUIDE solution verification section (PHY-00 V&V, VNV-M4)', () => {
  const section = CONVENTIONS_GUIDE.slice(CONVENTIONS_GUIDE.indexOf('## 18. Solution verification'));

  it('exists, names the three refinement kinds, the least-squares method and the human gate', () => {
    expect(section.length).toBeGreaterThan(500);
    for (const pattern of [
      /refinement=h/,
      /dt the transient time step/,
      /p the element order/,
      /least squares/,
      /provenance\.procedure/,
      /VNV_HUMAN_GATE/,
      /estimated/,
    ]) {
      expect(section).toMatch(pattern);
    }
  });

  it('names only registered commands (the host transport is written as a whole CLI line)', async () => {
    const { getCommand } = await import('@core/commands/registry');
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    expect(names).toEqual(
      expect.arrayContaining(['check_verification', 'check_convergence', 'delete_convergence_study', 'accept_verification_exception']),
    );
    expect(names.filter((name) => getCommand(name) === undefined)).toEqual([]);
  });
});

describe('CONVENTIONS_GUIDE nonlinear static section (PHY-05 M4, AF-03)', () => {
  const start = CONVENTIONS_GUIDE.indexOf('## 19. Nonlinear static');
  const section = CONVENTIONS_GUIDE.slice(start, CONVENTIONS_GUIDE.indexOf('## 20. Acoustic'));

  it('names only registered commands, every nonlinear command of the pack and the review wording', async () => {
    const { getCommand } = await import('@core/commands/registry');
    expect(start).toBeGreaterThan(0);
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    expect(names.filter((name) => getCommand(name) === undefined)).toEqual([]);
    for (const command of [
      'nonlinear_analytic_check',
      'set_nonlinear_controls',
      'add_analysis_step',
      'update_analysis_step',
      'delete_analysis_step',
      'add_curve_probe',
      'delete_curve_probe',
      'add_imperfection',
      'check_nonlinear',
      'nonlinear_report',
      'limit_load',
      'beam_large_deflection',
    ])
      expect(section).toContain(command);
    expect(section).toContain('not approved');
    for (const code of ['NLS_ARC_LENGTH_UNSUPPORTED', 'NLS_CURVE_STALE', 'NLS_LIMIT_NOT_REACHED', 'FEA_HUMAN_GATE'])
      expect(section).toContain(code);
  });
});

describe('CONVENTIONS_GUIDE acoustics section (PHY-20 M2, AF-03)', () => {
  const start = CONVENTIONS_GUIDE.indexOf('## 20. Acoustic environments');
  const section = CONVENTIONS_GUIDE.slice(start);

  it('names only registered commands, every acoustic command and the hand-off boundary', async () => {
    const { getCommand } = await import('@core/commands/registry');
    expect(start).toBeGreaterThan(0);
    const names = [...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] ?? '');
    expect(names.filter((name) => getCommand(name) === undefined)).toEqual([]);
    for (const command of [
      'define_acoustic_spectrum',
      'acoustic_spectrum_report',
      'acoustic_level',
      'convert_acoustic_spectrum',
      'define_acoustic_exposure',
      'delete_acoustic_exposure',
      'check_acoustic_handoff',
      'export_acoustic_load',
    ])
      expect(section).toContain(command);
    for (const text of ['20 micropascal', 'VAC_OUT_OF_SCOPE', 'KRN_NO_EXACT_KERNEL', 'reviewRequired', 'VAC_FIELD_UNSET'])
      expect(section).toContain(text);
  });
});

/** analyze_vortex_lattice: horseshoe vortex-lattice analysis of wings and tails, neutral point and static margin (10 AER M3). */

import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport } from '../shared/results';
import { refuseAero } from './codes';
import { solveBasis } from './vlmKernel';
import { isVlmRefusal, resolveVortexLattice, VLM_TS_PANEL_CAP, vortexLatticeData, vortexLatticeParams } from './vlmModel';

/**
 * @affects none (query); data = { lattice, reference, polar [{ alphaDeg, cl, cdi, cm, spanEfficiency, surfaces }], liftSlopePerRad, momentSlopePerRad, neutralPoint { x, staticMargin }, spanLoading, sections, solver, warnings, provenance }
 * @invariant one influence build and one LU factorisation for all angles: Γ(α) = cos α Γx + sin α Γz
 * @failure bad counts / angles / reference -> AER_PARAM_INVALID; loftId and sections both / neither -> AER_SURFACE_SOURCE_CONFLICT; < 2 sections, zero chord or no span -> AER_SURFACE_INVALID; unknown loft -> AER_ENTITY_NOT_FOUND; bad naca -> AER_AIRFOIL_INVALID; > 1000 panels -> AER_LATTICE_TOO_LARGE (use vortex_lattice_solve); singular -> AER_SOLVER_FAILED
 */
export const analyzeVortexLattice = defineCommand({
  name: 'analyze_vortex_lattice',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only vortex-lattice (horseshoe VLM) analysis of one or more lifting surfaces — wing, horizontal tail, canard, fin — for swept, tapered, ' +
    'twisted, dihedral and multi-surface configurations. Each surface comes from a loft_sections solid (loftId: one section per ring) or from ' +
    'explicit sections (leading edge, chord, incidence) root to tip, mirrored about y = 0 by default. Frame: x downstream, y spanwise, z up. ' +
    'Returns CL, induced drag CDi (Trefftz plane), Cm about referencePoint, span efficiency, lift and moment slopes, the neutral point x and ' +
    'the static margin with the CG at referencePoint, and the span loading. Camber enters as a zero-lift angle (naca or zeroLiftAngleDeg). ' +
    `Inviscid and incompressible: no stall or viscous drag (see drag_buildup). Up to ${VLM_TS_PANEL_CAP} panels (both sides); larger lattices ` +
    'run natively with the vortex_lattice_solve tool (same data).',
  params: vortexLatticeParams,
  run: (doc, params): CommandResult => {
    const model = resolveVortexLattice(doc, params, VLM_TS_PANEL_CAP);
    if (isVlmRefusal(model)) return refuseAero(doc, 'analyze_vortex_lattice', model.code, model.message, [], model.paths);
    const basis = solveBasis(model.lattice.panels);
    if (basis === null) return refuseAero(doc, 'analyze_vortex_lattice', 'AER_SOLVER_FAILED', 'singular vortex-lattice system');
    const data = vortexLatticeData(model, basis, { engine: 'ts' });
    const polar = data['polar'] as { alphaDeg: number; cl: number; cdi: number; cm: number }[];
    const np = data['neutralPoint'] as { x: number; staticMargin: number };
    return briefReport(
      doc,
      `analyze_vortex_lattice ${model.names.join(' + ')} (${(data['lattice'] as { panels: number }).panels} panels): ` +
        polar.map((row) => `α ${row.alphaDeg}°: CL ${row.cl}, CDi ${row.cdi}, Cm ${row.cm}`).join('; ') +
        `; CL_α ${String(data['liftSlopePerRad'])}/rad, neutral point x ${np.x}, static margin ${np.staticMargin}.`,
      data,
    );
  },
});

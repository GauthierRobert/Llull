import type { PhysicsIntent } from './intent';

/**
 * Renders the physics intent as the brief a lead engineer hands to an analyst: the model is already specified (geometry, material, load, supports),
 * the job is to SOLVE it and prove the number: a convergence study, the observed order and the estimated error against the owner's target, never an
 * extrapolation of a result that does not converge, never an acceptance an engineer has not signed.
 */
export function physicsBrief(intent: PhysicsIntent): string {
  const [width, depth, length] = intent.bar.size;
  return [
    `# ${intent.title}`,
    '',
    'Units: millimetres, newtons, MPa. Client: structures group, internal review.',
    '',
    '## Model',
    `- A steel bar ${width} mm x ${depth} mm in section and ${length} mm long along z (box from the origin), E = ${intent.bar.youngMpa} MPa, nu = ${intent.bar.poisson}, density 7.8 g/cm3 (company data).`,
    '- Static analysis with the CalculiX solver, N-mm-t-s units, the bar a solid part. Fixed at its z = 0 end face; a total force of 0, 9, 0 N (limit load, load case LC1) on the free end face at z = 8.',
    '- Quadratic tetrahedra (Netgen), a mesh-size parameter `mesh_h` = 0.25 mm drives the global size. A result probe `tip` at (0.5, 0.5, 8) reads the displacement u_y.',
    '',
    '## What the owner needs',
    `- The tip deflection u_y at the probe, with an estimated discretisation error: ${(intent.gciTarget * 100).toFixed(0)} % is the required GCI of the finest mesh (the owner's target; there is no default).`,
    `- Prove it with a mesh-convergence study of the probe: ${intent.levels} refinement levels at a ratio of ${intent.ratio}, then check the verification of the analysis against that target.`,
    '- Report the observed order, the extrapolated value and the GCI as estimated values. If a study does not converge (oscillating or diverging), say so and do not report an extrapolated value.',
    '- Do not accept a verification exception yourself: that is a signed act of a qualified reviewer, hand it over.',
    '',
    '## Deliverable',
    '- The analysis with its recorded convergence study, current (not stale) and verified against the stored artifacts, and the saved project file.',
  ].join('\n');
}

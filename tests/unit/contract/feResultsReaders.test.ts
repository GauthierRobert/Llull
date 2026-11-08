/**
 * Every code path of packages/domain-cae/src that obtains an FE results artifact (reads the artifact port or the trust verifier) is classified:
 * GATED (its verdict goes through the through-thickness mesh adequacy gate, TR-INT-08) or EXEMPT (with the reason it needs none). A new reader fails
 * this test until it is classified, so a new numeric verdict cannot silently skip the gate.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = 'packages/domain-cae/src';
/** A file reads FE artifacts when it touches the artifact port or imports the trust verifier. */
const READER = /feaArtifacts|shared\/trust'/;

/** Gated readers: the file must contain the call that applies the gate (directly, or by delegating to the gated margin / structure checks). */
const GATED: Readonly<Record<string, RegExp>> = {
  'margins/computeMargins.ts': /adequacyOf\(.*\)[\s\S]*gateRows\(/,
  'fatigue/feField.ts': /adequacyOf\(/,
  'fatigue/computeFatigue.ts': /acceptInadequateMesh/,
  'thermomech/distortion.ts': /adequacyOf\([\s\S]*blocksAssessment\(/,
  'commands/checkStructure.ts': /adequacyOf\(|meshAdequacy\(/,
  'commands/check.ts': /structureItems\([\s\S]*marginItems\(/,
};

/** Exempt readers and why: none issues a stress / fatigue / distortion pass-fail verdict that depends on the through-thickness resolution. */
const EXEMPT: Readonly<Record<string, string>> = {
  'commands/analysis.ts': 'reads the case state only (unmeshed / meshed / solved), no result values',
  'commands/probeHistory.ts': 'a probe history is a read-out of nodal values with its hash; reviewRequired, no allowable, no verdict',
  'commands/record.ts': 'records a summary after re-hashing the artifact (record_fe_mesh / record_fea_results); no engineering verdict',
  'commands/report.ts': 'fea_report states what was solved and its adequacy is shown by check_analysis; it issues no pass / fail margin',
  'commands/resultField.ts': 'a result field read-out (values, statistics) for the agent; no allowable, no verdict',
  'results/plotRequest.ts': 'builds a plot request of a verified field for the renderer; a picture, not a verdict',
  'dynamics/check.ts': 'modal / buckling / dynamic checks judge frequencies, participation and factors, not a stress margin',
  'dynamics/reportCommands.ts': 'modal and dynamic report read-outs (frequencies, mode shapes); no stress allowable',
  'explicit/queries.ts': 'explicit-dynamics artifacts (fe_explicit), not fe_results; energy and contact read-outs',
  'explicit/record.ts': 'records an explicit-dynamics artifact summary after re-hashing it; no verdict',
  'explicit/trust.ts': 'verifier of explicit-dynamics artifacts (fe_explicit), not fe_results',
  'vnv/checkVerification.ts':
    'solution-verification readiness (PHY-00): measures the discretisation error of a quantity across mesh levels, i.e. the resolution itself; it issues no stress margin (compute_margins, gated, does). VALID ONLY WHILE no margin or release verdict consults it: the day one does, it moves to GATED',
  'vnv/recordConvergenceStudy.ts':
    'records a convergence study after re-deriving every level from its mesh and results artifacts (like record.ts); no engineering verdict',
  'vnv/studyCommands.ts':
    'delete_convergence_study and the human gate accept_verification_exception (re-verifies the study through studyVerify before the gate); it records an acceptance, no stress verdict',
  'vnv/studyVerify.ts':
    're-derives the levels of a convergence study from the artifact store for the study commands; a trust check, no stress verdict',
  'nonlinear/imperfectionCommand.ts':
    'add_imperfection reads the pinned buckling results only to name the peak node and offset in its summary; no allowable, no verdict',
  'nonlinear/imperfectionDeck.ts':
    'reads the pinned buckling mode shapes to move the deck nodes (an input geometry, not a result verdict); no allowable, no pass / fail',
  'nonlinear/limitLoadQuery.ts':
    'limit_load is a read-out of a curve (reviewRequired, VNV_NO_CONVERGENCE_STUDY warning); the limit-load MARGIN verdict is margins/limitLoadMargins.ts, which applies gateRows',
  'thermal/check.ts':
    'heat-transfer set-up and results checks: temperatures, no through-thickness bending budget (TR-INT-07 is a structural budget)',
  'thermal/dispose.ts': 'records a human disposition of a thermal limit row; it reads the rows the thermal check computed',
  'thermal/limitsCheck.ts':
    'temperature limits of a heat-transfer result: a temperature field has no bending-resolution budget in TR-INT-07',
  'thermal/report.ts': 'heat-transfer report read-out; no structural verdict',
  'thermal/resultsAccess.ts': 'loads the verified thermal artifacts for the thermal commands; no verdict of its own',
  'thermomech/check.ts':
    'readiness items of a thermo-mechanical chain (staleness, mapping, units); the stress verdict is compute_margins, which is gated',
  'thermomech/field.ts': 'maps the solved temperature field to the stress case (a provider of nodal temperatures); no verdict',
  'topology/checkQuery.ts': 'topology-optimization artifacts (fe_topology): density field checks, not a stress margin',
  'topology/rebuildCompliance.ts': 'compares compliance of a rebuilt design to the topology result: a stiffness ratio, not a stress margin',
  'topology/rebuildQueries.ts': 'topology rebuild suggestions from the density field; no stress verdict',
  'topology/record.ts': 'records a topology artifact summary after re-hashing it; no verdict',
  'topology/reportQuery.ts': 'topology report read-out; no stress verdict',
  'topology/trust.ts': 'verifier of topology artifacts (fe_topology), not fe_results',
};

const sources = (): Map<string, string> =>
  new Map(
    readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => path.endsWith('.ts'))
      .map((path): [string, string] => [path, readFileSync(`${ROOT}/${path}`, 'utf8')]),
  );

describe('FE results readers are gated or exempt with a reason (TR-INT-08)', () => {
  const files = sources();
  const readers = [...files].filter(([, text]) => READER.test(text)).map(([path]) => path);

  it('every reader is classified; no classification is stale', () => {
    const classified = new Set([...Object.keys(GATED), ...Object.keys(EXEMPT)]);
    expect(readers.filter((path) => !classified.has(path))).toEqual([]);
    expect([...classified].filter((path) => !readers.includes(path))).toEqual([]);
    expect(Object.keys(GATED).filter((path) => path in EXEMPT)).toEqual([]);
  });

  it('a gated reader applies the adequacy gate', () => {
    for (const [path, gate] of Object.entries(GATED)) expect(files.get(path), path).toMatch(gate);
  });

  it('an exempt reader neither measures nor gates adequacy (else it belongs in GATED), and states a reason', () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(files.get(path), path).not.toMatch(/adequacyOf\(|meshAdequacy\(|FEA_MESH_INADEQUATE|acceptInadequateMesh/);
      expect(reason.length, path).toBeGreaterThan(30);
    }
  });
});

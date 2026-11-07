import type { Scenario } from '../contract';
import { physicsBrief } from '../physics/brief';
import { physicsIntent } from '../physics/intent';
import { physicsScript } from '../physics/script';
import { physicsVerificationCriteria } from '../criteria/physicsVerification';

/**
 * Physics-office job (PHY-00 V1, FR-VNV-12): a finite-element result proved to the owner's accuracy target. The scripted driver builds the 05 cantilever,
 * runs the convergence study through the host transport (real Netgen + CalculiX) and checks the verification; the agent gets only the brief. Needs the
 * FE tools, so the in-process run skips it (`hostTools`); the scripted gate skips it where Netgen or CalculiX is absent.
 */
export const physicsBenchmarks: Scenario = {
  id: 'physics-benchmarks',
  title: 'Cantilever tip deflection — mesh-convergence study against the owner target',
  client: 'Structures group (internal review)',
  brief: physicsBrief(physicsIntent),
  get script() {
    return physicsScript(physicsIntent);
  },
  hostTools: ['run_convergence_study'],
  criteria: physicsVerificationCriteria(physicsIntent),
  knownIssues: { scripted: [], ui: [] },
  agentBaseline: 0.6,
};

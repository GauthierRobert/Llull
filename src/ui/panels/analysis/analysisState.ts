// Plain-words reading of the lifecycle state of an analysis case (describe_analysis `state`), shared by the list and the case header.

import type { StatusTone } from '@ui/panels/PanelParts';

export interface StateInfo {
  readonly label: string;
  readonly tone: StatusTone;
  /** One line saying what the state means; empty when the label says it all. */
  readonly meaning: string;
  /** Warning styling: the numbers of this case cannot be relied on as they are. */
  readonly warning: boolean;
}

const KNOWN: Readonly<Record<string, StateInfo>> = {
  unmeshed: { label: 'not meshed', tone: 'info', meaning: 'No mesh yet: run fea_mesh.', warning: false },
  meshed: { label: 'meshed', tone: 'info', meaning: 'Mesh ready: run fea_solve.', warning: false },
  solved: { label: 'solved', tone: 'ok', meaning: '', warning: false },
  stale: { label: 'stale', tone: 'warn', meaning: 'Inputs changed since the mesh / solve: re-run them.', warning: true },
  missing: {
    label: 'missing',
    tone: 'warn',
    meaning: 'Recorded without its artifact, or the artifact is not on this machine.',
    warning: true,
  },
  untrusted: {
    label: 'untrusted',
    tone: 'bad',
    meaning: 'Recorded summary differs from its artifact: numbers are not shown as results.',
    warning: true,
  },
};

export function stateInfo(state: string): StateInfo {
  return KNOWN[state] ?? { label: state, tone: 'info', meaning: '', warning: false };
}

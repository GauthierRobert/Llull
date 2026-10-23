/** `ExecutionContext.cfdResults` over the FE artifact store: the same content-addressed files, read back as `cfd_result` artifacts only. */

import type { CfdResultPort } from '@core/model/cfdResult';
import type { FeArtifactStore } from '../fea/artifactStore';

export function cfdResultPort(store: FeArtifactStore): CfdResultPort {
  return {
    get(hash) {
      const artifact = store.getAny(hash);
      return artifact !== null && artifact.kind === 'cfd_result' ? artifact : null;
    },
  };
}

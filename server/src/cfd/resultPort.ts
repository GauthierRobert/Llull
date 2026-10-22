/** `ExecutionContext.cfdResults` over the FE artifact store: the same content-addressed files, read back as `cfd_result` artifacts only. */

import type { FeArtifactPort } from '@core/model/analysis';
import type { CfdResultPort } from '@core/model/cfdResult';

export function cfdResultPort(store: FeArtifactPort): CfdResultPort {
  return {
    get(hash) {
      const artifact = store.get(hash);
      return artifact !== null && artifact.kind === 'cfd_result' ? artifact : null;
    },
  };
}

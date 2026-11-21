/** Content hash of a stored FE artifact: sha256 of its canonical JSON, computed at most once per artifact object (artifacts are immutable). */

import type { FeArtifactPort } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

const hashes = new WeakMap<object, string>();

/**
 * @invariant equals `sha256Hex(canonicalJson(artifact))`; a port that verified the artifact when it read it (`FeArtifactPort.hashOf`)
 *   answers instead of a second pass over a mesh-sized object
 */
export function artifactHash(artifact: object, port?: FeArtifactPort | null): string {
  const known = hashes.get(artifact);
  if (known !== undefined) return known;
  const hash = port?.hashOf?.(artifact) ?? sha256Hex(canonicalJson(artifact));
  hashes.set(artifact, hash);
  return hash;
}

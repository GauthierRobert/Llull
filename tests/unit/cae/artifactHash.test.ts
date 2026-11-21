/** Content hash of a stored FE artifact: once per object, from the port when it verified the bytes itself (PERF1). */
import { describe, expect, it } from 'vitest';
import type { FeArtifactPort } from '@core/model/analysis';
import { artifactHash } from '@cae/shared/artifactHash';
import { fetchArtifact } from '@cae/shared/trust';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { hashOf, solvedBar } from './deckFixtures';

describe('artifactHash', () => {
  it('is the sha256 of the canonical JSON, whatever the key order', () => {
    const artifact = { kind: 'fe_table', rows: [[0, 0, 0, 20]] };
    expect(artifactHash(artifact)).toBe(sha256Hex(canonicalJson(artifact)));
    expect(artifactHash({ rows: [[0, 0, 0, 20]], kind: 'fe_table' })).toBe(artifactHash(artifact));
  });

  it('asks the port once for an artifact it verified and hashes only what the port does not know', () => {
    const bar = solvedBar();
    let asked = 0;
    const port: FeArtifactPort = {
      get: (hash) => bar.port.get(hash),
      hashOf: (artifact) => {
        asked += 1;
        return artifact === bar.mesh ? bar.meshHash : null;
      },
    };
    expect(artifactHash(bar.mesh, port)).toBe(bar.meshHash);
    expect(artifactHash(bar.mesh, port)).toBe(bar.meshHash);
    expect(asked).toBe(1);
    expect(artifactHash(bar.results, port)).toBe(hashOf(bar.results));
    expect(asked).toBe(2);
  });

  it('fetchArtifact still refuses content that does not hash to its name when the port verified nothing', () => {
    const bar = solvedBar();
    const forged = { ...bar.mesh, mesher: 'forged' };
    const lying: FeArtifactPort = { get: () => forged, hashOf: () => null };
    expect(fetchArtifact(lying, bar.meshHash, 'fe_mesh')).toMatchObject({ code: 'FEA_SUMMARY_MISMATCH' });
    expect(fetchArtifact({ get: () => forged }, bar.meshHash, 'fe_mesh')).toMatchObject({ code: 'FEA_SUMMARY_MISMATCH' });
    expect(fetchArtifact(bar.port, bar.meshHash, 'fe_mesh')).toMatchObject({ artifact: bar.mesh });
  });
});

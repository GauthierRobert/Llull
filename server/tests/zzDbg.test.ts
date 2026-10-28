import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { resolveDeferred } from '../src/native/deferredRun';
it('dbg', async () => {
  const engine = createNativeMeshEngine({ binary: nativeBinaryPath('llull-compute') as string })!;
  const mesh = { positions: [0, 0, 0, 1, 0, 0, 1, 0.001, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 0.5, 1], indices: [0, 1, 3, 1, 0, 4, 0, 2, 5] };
  let out = '';
  for (const weldTolerance of [0, 1e-9]) {
    const op = { op: 'repair', mode: 'stitch', weldTolerance, maxGap: 0.01, maxBoundaryEdges: 1000 } as const;
    const ts = tsMeshEngine.run({ mesh }, op) as any;
    const nat = (await resolveDeferred(() => engine.run({ mesh }, op))) as any;
    out += `tol=${weldTolerance}\n ts=${JSON.stringify(ts.report)}\n nat=${JSON.stringify(nat.report ?? nat)}\n`;
  }
  writeFileSync(process.env['DBG_OUT'] as string, out);
});

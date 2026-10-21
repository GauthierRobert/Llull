import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callNativeMesher, parseMesherOutput } from '../src/fea/nativeMesher';

describe('parseMesherOutput', () => {
  it('reads the last non-empty line, ignoring what Gmsh printed before it', () => {
    const stdout = 'Info : Reading STEP\n\n{"ok":true,"nodes":[[1,0,0,0]]}\n\n';
    expect(parseMesherOutput(stdout)).toEqual({ ok: true, nodes: [[1, 0, 0, 0]] });
  });

  it('is null for no output, a non-JSON line or a line without `ok`', () => {
    expect(parseMesherOutput('')).toBeNull();
    expect(parseMesherOutput('Segmentation fault\n')).toBeNull();
    expect(parseMesherOutput('{"nodes":[]}\n')).toBeNull();
    expect(parseMesherOutput('[1,2]\n')).toBeNull();
  });
});

describe('callNativeMesher', () => {
  it('rejects with FEA_TOOL_MISSING when the binary cannot start', async () => {
    await expect(callNativeMesher(path.join(tmpdir(), 'no-such-llull-mesh'), { op: 'mesh' }, 10_000, process.env)).rejects.toThrow(
      /cannot start llull-mesh.*FEA_TOOL_MISSING/,
    );
  });

  it('rejects when the process answers no response line', async () => {
    // node reads the request as a script, fails on it and prints nothing to stdout
    await expect(callNativeMesher(process.execPath, { op: 'mesh' }, 10_000, process.env)).rejects.toThrow(/without a response/);
  });
});

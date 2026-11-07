/**
 * export_dxf validated by an external reader: the golden 2D drawing is saved the way `llull ... --save x.dxf` writes it, then ezdxf (the bundled
 * Python, or LLULL_PYTHON / python3) loads and audits it. Skips cleanly when no Python with ezdxf is available.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { goldenDraft } from '../../tests/helpers/draft2dGolden';
import { filesOfData, saveDataFiles } from '../src/cli/saveFiles';

const SCRIPT = `
import sys, json, ezdxf
doc = ezdxf.readfile(sys.argv[1])
auditor = doc.audit()
msp = doc.modelspace()
types = {}
for e in msp:
    types[e.dxftype()] = types.get(e.dxftype(), 0) + 1
line = msp.query('LINE')[0]
circle = msp.query('CIRCLE')[0]
hatches = [{'solid': h.dxf.solid_fill, 'paths': len(h.paths)} for h in msp.query('HATCH')]
spline = msp.query('SPLINE')[0]
print(json.dumps({
  'version': doc.dxfversion,
  'errors': [e.message for e in auditor.errors],
  'fixes': [e.message for e in auditor.fixes],
  'types': types,
  'line': [list(line.dxf.start), list(line.dxf.end)],
  'circle': [list(circle.dxf.center), circle.dxf.radius],
  'hatches': hatches,
  'splineControl': len(list(spline.control_points)),
  'layers': sorted(l.dxf.name for l in doc.layers),
  'units': doc.header['$INSUNITS'],
  'layouts': sorted(doc.layouts.names()),
}))
`;

function ezdxfPython(): string | null {
  const candidates = [process.env['LLULL_PYTHON'], 'python3', 'python'].filter(
    (name): name is string => name !== undefined && name !== '' && name !== 'off',
  );
  return (
    candidates.find((python) => spawnSync(python, ['-I', '-c', 'import ezdxf'], { encoding: 'utf8', timeout: 60_000 }).status === 0) ?? null
  );
}

const python = ezdxfPython();

describe('export_dxf --save', () => {
  it('the CLI save path writes data.dxf under the suggested name', () => {
    const { data } = execute(goldenDraft(), 'export_dxf', {});
    const [file] = filesOfData(data);
    expect(file?.name).toBe('drawing.dxf');
    expect(file?.bytes.toString('utf8')).toBe((data as { dxf: string }).dxf);
    const svg = execute(goldenDraft(), 'export_svg', {}).data;
    expect(filesOfData(svg)[0]?.name).toBe('drawing.svg');
  });
});

describe.skipIf(python === null)('export_dxf audited by ezdxf', () => {
  it('loads as R2000 with no audit error or fix, and the entities read back as written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-x3-'));
    try {
      const target = path.join(dir, 'golden.dxf');
      saveDataFiles(execute(goldenDraft(), 'export_dxf', {}).data, target);
      expect(readFileSync(target, 'utf8').startsWith('0\nSECTION')).toBe(true);
      const run = spawnSync(python as string, ['-I', '-c', SCRIPT, target], { encoding: 'utf8', timeout: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(run.stdout) as {
        version: string;
        errors: string[];
        fixes: string[];
        types: Record<string, number>;
        line: number[][];
        circle: [number[], number];
        hatches: Array<{ solid: number; paths: number }>;
        splineControl: number;
        layers: string[];
        units: number;
        layouts: string[];
      };
      expect(report.version).toBe('AC1015');
      expect(report.errors).toEqual([]);
      expect(report.fixes).toEqual([]);
      expect(report.types).toEqual({ LWPOLYLINE: 5, TEXT: 3, HATCH: 3, ELLIPSE: 2, SPLINE: 2, LINE: 1, ARC: 1, CIRCLE: 1, POINT: 1 });
      // line-1: (0,0)-(10,5) rotated 0.3 rad about its origin, placed at (2,3) at elevation 1.5
      const [c, s] = [Math.cos(0.3), Math.sin(0.3)];
      const expected = [
        [2, 3, 1.5],
        [2 + 10 * c - 5 * s, 3 + 10 * s + 5 * c, 1.5],
      ];
      report.line.forEach((point, index) =>
        point.forEach((value, axis) => expect(value).toBeCloseTo((expected[index] as number[])[axis] as number, 9)),
      );
      expect(report.circle[0]?.slice(0, 2)).toEqual([2, 3]);
      expect(report.circle[1]).toBe(1.5);
      expect(report.hatches).toEqual([
        { solid: 0, paths: 2 },
        { solid: 0, paths: 1 },
        { solid: 1, paths: 1 },
      ]);
      // 4 Bezier segments of the 5-point open spline: 3 * 4 + 1 control points
      expect(report.splineControl).toBe(13);
      expect(report.layers).toEqual(['0', 'Defpoints', 'Notes & dims', 'WALLS']);
      expect(report.units).toBe(4);
      expect(report.layouts).toEqual(['Layout1', 'Model']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty drawing is refused before any file is written', () => {
    const result = execute(createEmptyDocument(), 'export_dxf', {});
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe('EXPORT2D_NO_ENTITIES');
  });
});

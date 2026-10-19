/** Live OpenCascade: insert_fastener_stack cuts an EXACT hole (VC-MAT-10, rel 1e-6) and bill_of_materials reports exact material mass (VC-MAT-11). */
import { expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { FastenerStack } from '@core/model/fasteners';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });

const inches = (value: number, unit = 'in'): { value: number; unit: string } => ({ value, unit });
const catalog = {
  format: 'llull-fastener-catalog',
  schemaVersion: 1,
  families: [
    {
      id: 'TEST-BOLT',
      kind: 'bolt',
      standard: { body: 'test', id: 'TEST-BOLT' },
      partNumber: [
        { kind: 'literal', text: 'TB' },
        { kind: 'int', name: 'diameterDash', width: 2 },
        { kind: 'literal', text: '-' },
        { kind: 'int', name: 'gripDash', scale: 0.0625, unit: 'in' },
      ],
      gripIncrement: inches(0.0625),
      gripMode: 'min_grip_ge_stack',
      lengthRule: { kind: 'grip_plus_thread' },
      sizes: [{ dash: '3', nominalDiameter: inches(0.1875), threadLength: inches(0.3), dims: {} }],
      availableGripDash: { min: 1, max: 40 },
      licence: 'company-proprietary',
      provenance: { citation: 'synthetic OCC test data' },
    },
  ],
};

describeNative('fastener stack on the exact OpenCascade kernel', () => {
  const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CommandResult => {
    const result = execute(doc, name, params, ctx());
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.error, result.summary).toBeUndefined();
    return result;
  };

  it('plate volume = plate - pi r^2 t to rel 1e-6, and the BOM mass is the exact volume times the density', () => {
    let doc: CadDocument = { ...createEmptyDocument(), units: 'in' };
    doc = run(doc, 'import_fastener_catalog', { catalog }).document;
    const first = run(doc, 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
    const second = run(first.document, 'add_box', { size: [2, 1, 0.3125], anchor: 'min', position: [0, 0, 0.25] });
    doc = run(second.document, 'create_material', {
      name: 'al',
      density: 2.81,
      densityUnit: 'g/cm^3',
      color: '#bbbbbb',
      metalness: 1,
      roughness: 0.4,
    }).document;
    doc = run(doc, 'assign_material', { entityIds: [first.affected[0], second.affected[0]], materialName: 'al' }).document;

    const result = run(doc, 'insert_fastener_stack', {
      family: 'TEST-BOLT',
      diameterDash: '3',
      stackIds: [first.affected[0], second.affected[0]],
      axisPoint: [1, 0.5, 0],
      axis: [0, 0, 1],
      holeDiameter: inches(0.19),
    });
    const stack = (result.data as { stack: FastenerStack }).stack;
    expect(stack.fastener.partNumber).toBe('TB03-9');
    const exact = (id: string): number => {
      const entity = result.document.entities[id];
      if (entity?.kind !== 'mesh' || entity.brep === undefined) throw new Error(`plate ${id} has no exact recipe`);
      const shape = kernels.occt.evaluate(entity.brep);
      return kernels.occt.topology(shape!)?.volume ?? Number.NaN;
    };
    const hole = (thickness: number): number => Math.PI * 0.095 ** 2 * thickness;
    const [one, two] = stack.layers.map((layer) => exact(layer.entityId));
    expect(Math.abs((one as number) - (0.5 - hole(0.25))) / (0.5 - hole(0.25))).toBeLessThan(1e-6);
    expect(Math.abs((two as number) - (0.625 - hole(0.3125))) / (0.625 - hole(0.3125))).toBeLessThan(1e-6);

    const bom = run(result.document, 'bill_of_materials', { includeMaterials: true }).data as {
      materials: Array<Record<string, number | string>>;
    };
    const volume = (one as number) + (two as number);
    expect(bom.materials[0]).toMatchObject({ materialId: 'al', solidCount: 2, volumeMethod: 'exact' });
    expect(Math.abs((bom.materials[0]?.['totalVolume'] as number) - volume) / volume).toBeLessThan(1e-9);
    expect(Math.abs((bom.materials[0]?.['totalMass'] as number) - volume * 2.81 * 16.387064) / (volume * 2.81 * 16.387064)).toBeLessThan(
      1e-6,
    );
  });

  it('a row of two stacks keeps cutting the previously cut plates (ids followed through the exact recipes)', () => {
    let doc: CadDocument = { ...createEmptyDocument(), units: 'in' };
    doc = run(doc, 'import_fastener_catalog', { catalog }).document;
    const plate = run(doc, 'add_box', { size: [2, 1, 0.5625], anchor: 'min', position: [0, 0, 0] });
    const row = run(plate.document, 'insert_fastener_row', {
      family: 'TEST-BOLT',
      diameterDash: '3',
      stackIds: plate.affected,
      from: [0.5, 0.5, 0],
      to: [1.5, 0.5, 0],
      count: 2,
      holeDiameter: inches(0.19),
    });
    const stacks = Object.values(row.document.fasteners?.stacks ?? {});
    expect(stacks).toHaveLength(2);
    const id = stacks[0]?.layers[0]?.entityId as string;
    expect(stacks[1]?.layers[0]?.entityId).toBe(id);
    const entity = row.document.entities[id];
    const shape = entity?.kind === 'mesh' && entity.brep !== undefined ? kernels.occt.evaluate(entity.brep) : null;
    const volume = shape === null ? Number.NaN : (kernels.occt.topology(shape)?.volume ?? Number.NaN);
    const expected = 2 * 1 * 0.5625 - 2 * Math.PI * 0.095 ** 2 * 0.5625;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-6);
  });
});

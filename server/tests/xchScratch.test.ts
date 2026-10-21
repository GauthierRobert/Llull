import { it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();

describeNative('scratch', () => {
  it('prints', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
    const box = doc.order[0] ?? '';
    doc = execute(doc, 'set_entity_name', { id: box, name: 'Bolt' }).document;
    const created = execute(doc, 'create_component', { name: 'Bolt', entityIds: [box] });
    const componentId = Object.keys(created.document.components)[0] ?? '';
    const second = execute(created.document, 'insert_instance', { componentId, position: [50, 0, 0] });
    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const result = execute(second.document, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    process.stdout.write(`\nSUMMARY ${result.summary}\n${JSON.stringify(result.error)}\n`);
    const step = (result.data as { step?: string } | undefined)?.step ?? '';
    process.stdout.write(
      step
        .split('\n')
        .filter((l) => /PRODUCT\(|NEXT_ASSEMBLY|COLOUR|MANIFOLD_SOLID/.test(l))
        .join('\n') + '\n',
    );

    let d2 = createEmptyDocument();
    d2 = execute(d2, 'add_box', { size: [10, 10, 10], color: '#ff0000' }).document;
    d2 = execute(d2, 'add_cylinder', { radius: 3, height: 12, color: '#0000ff' }).document;
    const [a, b] = d2.order;
    d2 = execute(d2, 'set_entity_name', { id: a, name: 'Bearing 1' }).document;
    d2 = execute(d2, 'group_entities', { ids: [a, b], name: 'Pump' }).document;
    const r2 = execute(d2, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false }, ctx);
    const s2 = (r2.data as { step: string }).step;
    process.stdout.write(
      s2
        .split('\n')
        .filter((l) => /PRODUCT\(|NEXT_ASSEMBLY|COLOUR|MANIFOLD_SOLID|STYLED/.test(l))
        .join('\n') + '\n',
    );
  }, 240_000);
});

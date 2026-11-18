import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const controlledBox = (): void => {
  applyCommand('define_material_record', {
    id: 'secret',
    designation: 'X',
    specs: [],
    licence: 'company-proprietary',
    exportMarking: { regime: 'ITAR' },
  });
  const box = applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });
  applyCommand('assign_material', { materialName: 'secret', entityIds: box.affected });
};

describe('export of export-controlled content (TR-MAT-51)', () => {
  it('GET /export/step answers 403 with the gate code, not a 500 / 503', async () => {
    controlledBox();
    const res = await request(app).get('/export/step');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'MAT_EXPORT_CONTROLLED' });
    expect(String(res.body.error)).toContain('MAT_EXPORT_CONTROLLED');
  });

  it.each([
    ['export_stl', {}],
    ['export_code', { language: 'cadquery' }],
  ])('%s refuses with MAT_EXPORT_CONTROLLED and returns no data', (name, params) => {
    controlledBox();
    const result = applyCommand(name, params);
    expect(result.error?.code).toBe('MAT_EXPORT_CONTROLLED');
    expect(result.data).toBeUndefined();
  });
});

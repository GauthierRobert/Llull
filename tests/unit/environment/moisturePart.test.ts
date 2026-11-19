/** MOI-b: per-part moisture state in check_space_environment (FR-ENV-12): one item per part, findings carry the part ids. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { close, emptyMm, run, withMaterial, withPanel } from './fixtures';

interface MoistureItem {
  entityId: string;
  rootId: string;
  material: string;
  status: string;
  code: string;
  thickness: { value: number; unit: string } | null;
  moisturePercent: number | null;
  fraction: number | null;
  saturationPercent: number | null;
  massG: number | null;
  waterUptakeG: number | null;
  saturationWaterG: number | null;
  unverified: boolean;
}
interface Check {
  status: string;
  moisture?: { exposure: { relativeHumidity: number }; items: MoistureItem[] };
  findings: { code: string; severity: string; entityIds?: string[] }[];
}

const source = { citation: 'synthetic test value (PHY-14 validation pack)' };
const EXPOSURE = {
  relativeHumidity: 50,
  temperature: { value: 20, unit: 'degC' },
  duration: { value: 7, unit: 'd' },
  faces: 'both',
  source: 'storage specification',
};

/** A material with E595 values and moisture properties: D 1e-12 m^2/s (= 1e-6 mm^2/s), M_inf 1.5 %. */
function moistMaterial(doc: CadDocument, name: string, basis = 'company', diffusivity = true): CadDocument {
  let next = withMaterial(doc, name, { TML: 0.5, CVCM: 0.05 });
  if (diffusivity)
    next = run(next, 'set_material_property', {
      material: name,
      property: 'moistureDiffusivity',
      value: 1e-12,
      unit: 'm^2/s',
      basis,
      source,
    }).document;
  return run(next, 'set_material_property', { material: name, property: 'moistureSaturation', value: 1.5, unit: '%', basis, source })
    .document;
}

const withMission = (doc: CadDocument): CadDocument =>
  run(doc, 'set_mission_environment', { outgassingProfile: 'nasa_gsfc_screening', humidityExposure: EXPOSURE }).document;

const check = (doc: CadDocument, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'check_space_environment', params);
const dataOf = (doc: CadDocument, params: Record<string, unknown> = {}): Check => check(doc, params).data as Check;
const THICKNESS = { value: 2, unit: 'mm' };

describe('check_space_environment per-part moisture state', () => {
  it('computes the moisture state of a part with a thickness through moisture_uptake, with its water mass; the status stays the outgassing one', () => {
    const panel = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    const doc = withMission(panel.document);
    const data = dataOf(doc, { moistureThickness: [{ entityId: panel.id, thickness: THICKNESS }] });
    const direct = execute(doc, 'moisture_uptake', { thickness: THICKNESS, material: 'composite', useMissionExposure: true }).data as {
      moisturePercent: number;
      fraction: number;
    };
    const item = data.moisture?.items[0];
    expect(item).toMatchObject({ entityId: panel.id, rootId: panel.id, material: 'composite', status: 'info', code: 'ENV_MOISTURE_STATE' });
    expect(item?.moisturePercent).toBe(direct.moisturePercent);
    expect(item?.moisturePercent).toBeCloseTo(1.2266, 4);
    expect(item?.fraction).toBe(direct.fraction);
    expect(item?.saturationPercent).toBe(1.5);
    expect(close(item?.massG ?? NaN, 200)).toBe(true);
    expect(close(item?.waterUptakeG ?? NaN, (direct.moisturePercent / 100) * 200)).toBe(true);
    expect(close(item?.saturationWaterG ?? NaN, 3)).toBe(true);
    expect(data.moisture?.exposure.relativeHumidity).toBe(50);
    expect(data.status).toBe('pass');
    expect(check(doc, { moistureThickness: [{ entityId: panel.id, thickness: THICKNESS }] }).summary).toContain(
      '1 of 1 part(s) with a moisture state',
    );
  });

  it('judges each part on its own: a part without a thickness is unknown with the saturation bound, and the finding names its id', () => {
    const first = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    const second = withPanel(first.document, 'composite');
    const data = dataOf(withMission(second.document), { moistureThickness: [{ entityId: first.id, thickness: THICKNESS }] });
    const byId = new Map((data.moisture?.items ?? []).map((item) => [item.entityId, item]));
    expect(byId.get(first.id)?.status).toBe('info');
    expect(byId.get(second.id)).toMatchObject({
      status: 'unknown',
      code: 'ENV_MOISTURE_THICKNESS_UNSET',
      moisturePercent: null,
      thickness: null,
    });
    expect(close(byId.get(second.id)?.saturationWaterG ?? NaN, 3)).toBe(true);
    const finding = data.findings.find((entry) => entry.code === 'ENV_MOISTURE_THICKNESS_UNSET');
    expect(finding).toMatchObject({ severity: 'info', entityIds: [second.id] });
  });

  it('a material without a diffusivity is unknown with the forwarded code and the part ids; unverified values are flagged per part', () => {
    let doc = moistMaterial(emptyMm(), 'dry', 'company', false);
    const dry = withPanel(doc, 'dry');
    doc = moistMaterial(dry.document, 'typical', 'typical');
    const typical = withPanel(doc, 'typical');
    const data = dataOf(withMission(typical.document), {
      moistureThickness: [
        { entityId: dry.id, thickness: THICKNESS },
        { entityId: typical.id, thickness: THICKNESS },
      ],
    });
    const byId = new Map((data.moisture?.items ?? []).map((item) => [item.entityId, item]));
    expect(byId.get(dry.id)).toMatchObject({ status: 'unknown', code: 'ENV_PROPERTY_MISSING', moisturePercent: null });
    expect(byId.get(typical.id)).toMatchObject({ status: 'info', unverified: true });
    expect(data.findings.find((entry) => entry.code === 'ENV_PROPERTY_MISSING')?.entityIds).toEqual([dry.id]);
    expect(data.findings.find((entry) => entry.code === 'ENV_VALUE_UNVERIFIED' && entry.entityIds !== undefined)?.entityIds).toEqual([
      typical.id,
    ]);
  });

  it('expands instances: the instance id gives the thickness of every child, a child id wins over it', () => {
    const panel = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    let doc = run(panel.document, 'create_component', { name: 'panel', entityIds: [panel.id], componentId: 'panel' }).document;
    doc = run(doc, 'insert_instance', { componentId: 'panel', position: [300, 0, 0] }).document;
    const instances = Object.values(doc.entities).filter((entity) => entity.kind === 'instance');
    expect(instances).toHaveLength(2);
    const [one, two] = instances.map((entity) => entity.id);
    const all = dataOf(withMission(doc), { moistureThickness: [{ entityId: one ?? '', thickness: THICKNESS }] });
    const items = all.moisture?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.rootId === one)).toMatchObject({ status: 'info', thickness: THICKNESS });
    expect(items.find((item) => item.rootId === two)?.status).toBe('unknown');
    const child = items.find((item) => item.rootId === one)?.entityId ?? '';
    expect(child).toContain('expanded::');
    const thin = { value: 1, unit: 'mm' };
    const overridden = dataOf(withMission(doc), {
      moistureThickness: [
        { entityId: one ?? '', thickness: THICKNESS },
        { entityId: child, thickness: thin },
      ],
    });
    expect(overridden.moisture?.items.find((item) => item.entityId === child)?.thickness).toEqual(thin);
  });

  it('has no moisture section without a mission humidity exposure', () => {
    const panel = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    expect(dataOf(panel.document, { profile: 'nasa_gsfc_screening' }).moisture).toBeUndefined();
  });

  it('refuses moistureThickness without an exposure or naming no screened part (document unchanged) and is pure', () => {
    const panel = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    const noExposure = check(panel.document, {
      profile: 'nasa_gsfc_screening',
      moistureThickness: [{ entityId: panel.id, thickness: THICKNESS }],
    });
    expect(noExposure.error?.code).toBe('ENV_PARAM_INVALID');
    expect(noExposure.error?.paths).toEqual(['moistureThickness']);
    expect(noExposure.document).toBe(panel.document);
    const doc = withMission(panel.document);
    const stray = check(doc, { moistureThickness: [{ entityId: 'nothing', thickness: THICKNESS }] });
    expect(stray.error?.code).toBe('ENV_PARAM_INVALID');
    expect(stray.error?.ids).toEqual(['nothing']);
    const before = JSON.stringify(doc);
    const result = check(doc, { moistureThickness: [{ entityId: panel.id, thickness: THICKNESS }] });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('forwards a bad thickness as an unknown item (moisture_uptake refusal), never a moisture state', () => {
    const panel = withPanel(moistMaterial(emptyMm(), 'composite'), 'composite');
    const data = dataOf(withMission(panel.document), { moistureThickness: [{ entityId: panel.id, thickness: { value: -1, unit: 'mm' } }] });
    expect(data.moisture?.items[0]).toMatchObject({ status: 'unknown', code: 'ENV_PARAM_INVALID', moisturePercent: null });
  });
});

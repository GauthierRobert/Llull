import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { FAT_PLANS, FRC_PLANS, runPlanFile } from './fatigue/support';

const refs = (doc: ReturnType<typeof runPlanFile>['document']): Array<{ material: string; id: string }> => {
  const durability = doc.analysis?.durability;
  if (durability === undefined) return [];
  return [
    ...Object.values(durability.fatigueCases).map((c) => ({ material: c.material.recordId, id: c.material.modelId })),
    ...Object.values(durability.crackGrowthCases).map((c) => ({ material: c.material.recordId, id: c.material.growthModelId })),
  ];
};

describe('durability reference guard', () => {
  for (const plan of [`${FAT_PLANS}/fat_history_only_miner.plan.json`, `${FRC_PLANS}/frc_paris_center_life.plan.json`]) {
    it(`refuses removing a material model a case uses (${plan.split('/').at(-1) ?? ''})`, () => {
      const { document } = runPlanFile(plan);
      const [ref] = refs(document);
      expect(ref).toBeDefined();
      if (ref === undefined) return;
      const result = execute(document, 'delete_material_model', ref);
      expect(result.document).toBe(document);
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(/is used by (fatigue|crack growth) case/);
    });
  }
});

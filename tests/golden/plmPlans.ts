/** Golden plan of 09 PLM (validation/plans/plm_release_eco_revB.plan.json): release A, ECR -> ECO -> revision B, release B. */

import type { GoldenAction } from './plans';

const approvals = [
  { role: 'design-authority', userId: 'u-0007' },
  { role: 'checker', userId: 'u-0011' },
];

export const plmPlans: Record<string, GoldenAction[]> = {
  plm_release_eco: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'set_parameter', params: { name: 'w', expression: '60' } },
    { command: 'set_parameter', params: { name: 't', expression: '4' } },
    { command: 'add_box', params: { size: ['=w', 40, '=t'] }, as: 'plate' },
    {
      command: 'create_sheet',
      params: { name: 'LL-1001', views: ['front', 'top', 'right'], partNumber: 'LL-1001', revision: 'A' },
      as: 'sheet',
    },
    {
      command: 'set_item_identity',
      params: {
        partNumber: 'LL-1001',
        name: 'Bracket, hinge fitting',
        itemType: 'part',
        revisionScheme: 'asme-alpha',
        policy: { humanSignatureRequired: false },
      },
    },
    { command: 'set_item_marking', params: { regime: 'none', statement: 'NLR-EXAMPLE', decidedBy: 'u-0003' } },
    { command: 'submit_for_review', params: { comment: 'ready for release', at: '2026-11-01T10:00:00Z', by: 'u-0007' } },
    {
      command: 'create_change_order',
      params: {
        id: 'ECO-0001',
        purpose: 'initial-release',
        affectedItems: ['LL-1001'],
        effectivity: [{ kind: 'serial', from: 1 }],
        at: '2026-11-01T12:00:00Z',
        by: 'u-0005',
      },
    },
    {
      command: 'release_item',
      params: { changeOrder: 'ECO-0001', effectivity: [{ kind: 'serial', from: 1 }], at: '2026-11-02T09:30:00Z', by: 'u-0007', approvals },
    },
    {
      command: 'create_change_request',
      params: {
        id: 'ECR-0002',
        title: 'Increase flange thickness 4 -> 5 mm',
        reason: 'SN-118 negative margin',
        affectedItems: ['LL-1001'],
        proposedClassification: 'minor',
        at: '2026-12-01T08:00:00Z',
        by: 'u-0021',
      },
    },
    {
      command: 'create_change_order',
      params: {
        id: 'ECO-0002',
        fromRequests: ['ECR-0002'],
        classification: 'minor',
        effectivity: [{ kind: 'serial', from: 5 }],
        at: '2026-12-03T08:00:00Z',
        by: 'u-0007',
      },
    },
    { command: 'revise_item', params: { changeOrder: 'ECO-0002', at: '2026-12-03T08:05:00Z', by: 'u-0007' } },
    { command: 'set_parameter', params: { name: 't', expression: '5' } },
    { command: 'update_sheet', params: { sheetId: '$sheet', revision: 'B', date: '2026-12-05' } },
    { command: 'submit_for_review', params: { comment: 'ECO-0002 implemented', at: '2026-12-04T10:00:00Z', by: 'u-0007' } },
    { command: 'release_item', params: { changeOrder: 'ECO-0002', at: '2026-12-05T09:00:00Z', by: 'u-0007', approvals } },
    { command: 'resolve_effectivity', params: { partNumber: 'LL-1001', kind: 'serial', unit: 4 } },
    { command: 'resolve_effectivity', params: { partNumber: 'LL-1001', kind: 'serial', unit: 5 } },
    { command: 'plm_status', params: {} },
  ],
};

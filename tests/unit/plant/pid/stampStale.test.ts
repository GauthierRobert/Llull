/**
 * Plant 04 PID-FU2: PID_STAMP_STALE (check_pid): a sheet signed for construction and changed afterwards. The stamp holds the content hash of the signed sheet;
 * the rule recomputes it, so the oracle is "same hash <=> not stale".
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { getPid, withPid } from '@aec/plant/pid/state';
import { apply, data } from '../../../helpers/commandAssertions';
import { runSteps } from './authoringFixtures';

const AT = '2026-11-05T09:30:00Z';
interface CheckData {
  items: Array<{
    code: string;
    severity: string;
    findingKey: string;
    sheet: string;
    item: string;
    ids: string[];
    values: Record<string, string>;
  }>;
  countsByCode: Record<string, number>;
  status: string;
}
const check = (doc: CadDocument, params: object = {}): CheckData => data<CheckData>(doc, 'check_pid', params);
const stale = (doc: CadDocument, params: object = {}): CheckData['items'] =>
  check(doc, { rules: ['PID_STAMP_STALE'], ...params }).items.filter((item) => item.code === 'PID_STAMP_STALE');

const port: HumanSignaturePort = {
  verify: (confirmation) => (typeof confirmation === 'object' && confirmation !== null ? { signer: 'alice', signatureId: 'sig-1' } : null),
  spend: () => true,
};
const issued = (): CadDocument => {
  const doc = runSteps([{ command: 'create_pid_sheet', params: { number: 'PID-009', paper: 'A3' } }]).doc;
  const result = execute(
    doc,
    'issue_pid_sheet',
    { sheet: 'PID-009', status: 'issued_for_construction', revision: '0', at: AT, confirmation: { nonce: 'n' } },
    { ...defaultContext(), humanSignature: port },
  );
  expect(result.rejected, result.summary).toBeUndefined();
  return result.document;
};

describe('check_pid: PID_STAMP_STALE', () => {
  it('a freshly signed sheet is not stale, and the rule is counted among the rules run', () => {
    const doc = issued();
    expect(stale(doc)).toEqual([]);
    expect(check(doc).countsByCode['PID_STAMP_STALE']).toBe(0);
  });

  it('an edit after the signature is a warning on the sheet (item = sheet number, sheet filter honoured) naming both hashes', () => {
    const edited = apply(issued(), 'add_pid_equipment', { sheet: 'PID-009', class: 'Tank', tag: 'T-900', at: [60, 150] });
    const found = stale(edited);
    expect(found).toHaveLength(1);
    const sheet = Object.values(getPid(edited).sheets)[0];
    expect(found[0]).toMatchObject({ severity: 'warning', sheet: 'PID-009', item: 'PID-009', ids: [sheet?.id] });
    expect(found[0]?.values['stampedSha256']).toBe(sheet?.issuedBy?.contentSha256);
    expect(found[0]?.values['currentSha256']).not.toBe(sheet?.issuedBy?.contentSha256);
    expect(found[0]?.values['signer']).toBe('alice');
    expect(stale(edited, { sheet: 'PID-009' })).toHaveLength(1);
    expect(check(edited, { rules: ['PID_STAMP_STALE'] }).status).toBe('warn');
  });

  it('accepting the finding hides it (a warning needs a name only); going back to draft clears the stamp and the finding', () => {
    const edited = apply(issued(), 'add_pid_equipment', { sheet: 'PID-009', class: 'Tank', tag: 'T-900', at: [60, 150] });
    const key = stale(edited)[0]?.findingKey as string;
    const accepted = apply(edited, 'accept_pid_finding', {
      findingKey: key,
      reason: 'tank added to the vendor package, known',
      by: 'bob',
      at: AT,
    });
    expect(stale(accepted)).toEqual([]);
    expect(check(accepted, { rules: ['PID_STAMP_STALE'], includeAccepted: true }).items).toHaveLength(1);
    const draft = apply(edited, 'issue_pid_sheet', { sheet: 'PID-009', status: 'draft', revision: '1', at: AT });
    expect(stale(draft)).toEqual([]);
  });

  it('a stamp with no content hash cannot be compared and a sheet without a stamp is never stale; the rule restricted to another sheet finds nothing', () => {
    const edited = apply(issued(), 'add_pid_equipment', { sheet: 'PID-009', class: 'Tank', tag: 'T-900', at: [60, 150] });
    const pid = getPid(edited);
    const [id, sheet] = Object.entries(pid.sheets)[0] as [string, NonNullable<(typeof pid.sheets)[string]>];
    const { contentSha256: _hash, ...bare } = sheet.issuedBy as NonNullable<typeof sheet.issuedBy>;
    const noHash = withPid(edited, { ...pid, sheets: { ...pid.sheets, [id]: { ...sheet, issuedBy: bare } } });
    expect(stale(noHash)).toEqual([]);
    const other = apply(edited, 'create_pid_sheet', { number: 'PID-010', paper: 'A3' });
    expect(stale(other, { sheet: 'PID-010' })).toEqual([]);
    expect(stale(other)).toHaveLength(1);
  });

  it('is pure: the document is unchanged by check_pid', () => {
    const doc = issued();
    const result = execute(doc, 'check_pid', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});

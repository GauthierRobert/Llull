/** Plant 09 §12.19 O3: `check_display` warns about a service / hazard colour profile that claims `reviewRequired: false` with no approval. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ColourProfile } from '@core/model/display';
import { isHazardProfile, profileSha256, unapprovedHazardProfile } from '@core/geometry/colourRules';
import { apply, data } from '../../helpers/commandAssertions';

const profile = (patch: Partial<ColourProfile> = {}): ColourProfile => ({
  id: 'svc',
  name: 'Service',
  palette: 'x',
  reviewRequired: false,
  defaultColour: 'entity',
  rules: [{ id: 'water', legend: 'Water', when: { property: 'plant.Service', equals: 'water' }, appearance: { colour: '#00aa00' } }],
  ...patch,
});

const docWith = (...profiles: ColourProfile[]): CadDocument => ({
  ...createEmptyDocument(),
  display: { colourProfiles: Object.fromEntries(profiles.map((item) => [item.id, item])) },
});

const codes = (doc: CadDocument): string[] =>
  data<{ issues: Array<{ code: string; paths: string[] }> }>(doc, 'check_display', {})
    .issues.filter((issue) => issue.code === 'VIS_PROFILE_UNAPPROVED')
    .map((issue) => `${issue.code}@${issue.paths[0]}`);

describe('check_display VIS_PROFILE_UNAPPROVED', () => {
  it('warns for a service profile with reviewRequired false and no approval, even when it is not active', () => {
    const found = codes(docWith(profile()));
    expect(found).toContain('VIS_PROFILE_UNAPPROVED@display.colourProfiles.svc');
    expect(data<{ status: string }>(docWith(profile()), 'check_display', {}).status).toBe('warn');
  });

  it('warns for a profile whose rule carries a pipe marker, and for a defined profile through the command', () => {
    const marked = profile({
      rules: [
        {
          id: 'm',
          legend: 'm',
          when: { property: 'kind', equals: 'box' },
          appearance: { colour: '#ff0000' },
          marker: { letters: 'WATER' },
        },
      ],
    });
    expect(codes(docWith(marked))).toContain('VIS_PROFILE_UNAPPROVED@display.colourProfiles.svc');
    const defined = apply(createEmptyDocument(), 'define_colour_profile', {
      id: 'fluid',
      name: 'Fluid',
      rules: [{ id: 'r', when: { property: 'Fluid', equals: 'steam' }, colour: '#ff0000', legend: 'Steam' }],
    });
    expect(codes(defined)).toContain('VIS_PROFILE_UNAPPROVED@display.colourProfiles.fluid');
  });

  it('is silent for a flagged profile, a matching approval, a stale approval is reported, and a non-hazard profile', () => {
    expect(codes(docWith(profile({ reviewRequired: true })))).toEqual([]);
    const signed = profile();
    const approved = profile({ approval: { signer: 'jo', signatureId: 'sig-1', profileSha256: profileSha256(signed) } });
    expect(codes(docWith(approved))).toEqual([]);
    const edited = { ...approved, rules: [{ ...(approved.rules[0] as ColourProfile['rules'][number]), legend: 'Edited' }] };
    expect(codes(docWith(edited))).toContain('VIS_PROFILE_UNAPPROVED@display.colourProfiles.svc');
    const plain = profile({
      rules: [{ id: 'k', legend: 'k', when: { property: 'kind', equals: 'box' }, appearance: { colour: '#ff0000' } }],
    });
    expect(codes(docWith(plain))).toEqual([]);
    expect(codes(createEmptyDocument())).toEqual([]);
  });

  it('classifies hazard profiles and is read-only', () => {
    expect(isHazardProfile(profile())).toBe(true);
    expect(unapprovedHazardProfile(profile({ reviewRequired: true }))).toBe(false);
    const doc = docWith(profile());
    const before = JSON.stringify(doc);
    codes(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

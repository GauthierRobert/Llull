/**
 * Plant 09 VIS-FU (Q5, §5.1): `define_palette` (owner palette named by profiles), `approve_colour_profile` (human gate bound to the exact mapping and the document), and the
 * activation of a profile keeping the rest of the display model.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { ColourProfile } from '@core/model/display';
import type { ExecutionContext } from '@core/commands/types';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { humanCtx, ledgerPort } from '../../review/humanActs';

const SCHEME = { scheme: 'asme_a13_1', profileId: 'svc', serviceMap: { 'cooling water': 'water' }, markerLetters: true };
const PAINT = { id: 'acme-paint', name: 'ACME paint system', colours: { Green: '#2E8B57', WHITE: '#FFFFFF' } };

const withPipe = (): CadDocument =>
  apply(createEmptyDocument(), 'add_pipe_run', {
    points: [
      [0, 0, 0],
      [1000, 0, 0],
    ],
    dn: 50,
    service: 'cooling water',
  });
const profile = (doc: CadDocument, id = 'svc'): ColourProfile | undefined => doc.display?.colourProfiles[id];

describe('define_palette', () => {
  it('stores colours lowercase, lets a scheme draw from the palette and names it in the profile', () => {
    const doc = apply(withPipe(), 'define_palette', PAINT);
    expect(doc.display?.palettes?.['acme-paint']).toEqual({
      id: 'acme-paint',
      name: 'ACME paint system',
      colours: { green: '#2e8b57', white: '#ffffff' },
    });
    const built = apply(doc, 'apply_service_colour_scheme', { ...SCHEME, palette: 'acme-paint' });
    expect(profile(built)).toMatchObject({ palette: 'acme-paint', reviewRequired: true });
    expect(profile(built)?.rules[0]?.appearance.colour).toBe('#2e8b57');
    expect(profile(built)?.rules[0]?.marker).toEqual({ letters: 'COOLING WATER', letterHex: '#ffffff' });
    const dflt = apply(withPipe(), 'apply_service_colour_scheme', SCHEME);
    expect(profile(dflt)).toMatchObject({ palette: 'llull-ral-approx-v1' });
    expect(profile(dflt)?.rules[0]?.appearance.colour).not.toBe('#2e8b57');
  });

  it('refuses a palette missing a colour of the scheme, an unknown palette, and bad definitions', () => {
    const doc = apply(withPipe(), 'define_palette', { id: 'greens', colours: { green: '#00ff00' } });
    expectRefusal(doc, 'apply_service_colour_scheme', { ...SCHEME, palette: 'greens' }, 'VIS_PALETTE_INCOMPLETE', 'palette');
    expectRefusal(doc, 'apply_service_colour_scheme', { ...SCHEME, palette: 'nope' }, 'VIS_PALETTE_NOT_FOUND', 'palette');
    expect(execute(doc, 'apply_service_colour_scheme', { ...SCHEME, markerLetters: false, palette: 'greens' }).rejected).toBeUndefined();
    const base = createEmptyDocument();
    for (const params of [
      { id: 'Bad Id', colours: { red: '#ff0000' } },
      { id: 'llull-ral-approx-v1', colours: { red: '#ff0000' } },
      { id: 'p', colours: { constructor: '#ff0000' } },
      { id: 'p', colours: {} },
      { id: 'p', colours: { red: 'red' } },
      { id: 'p', colours: { red: '#ff0000', RED: '#00ff00' } },
      { id: 'p', colours: { __proto__x: '#ff0000', ' ': '#ff0000' } },
      { id: 'p', colours: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`c${i}`, '#ffffff'])) },
    ])
      expectRefusal(base, 'define_palette', params, 'VIS_PALETTE_INVALID');
  });

  it('refuses a second definition without replace, and a replacement names the profiles that keep the old colours', () => {
    const built = apply(apply(withPipe(), 'define_palette', PAINT), 'apply_service_colour_scheme', { ...SCHEME, palette: 'acme-paint' });
    expectRefusal(built, 'define_palette', PAINT, 'VIS_PALETTE_EXISTS', 'id');
    const replaced = execute(built, 'define_palette', { ...PAINT, replace: true, colours: { green: '#112233', white: '#ffffff' } });
    expect(replaced.rejected).toBeUndefined();
    expect(replaced.data).toMatchObject({ replaced: true, profilesUsing: ['svc'] });
    expect(replaced.summary).toContain('svc');
    expect(profile(replaced.document)?.rules[0]?.appearance.colour).toBe('#2e8b57');
  });

  it('is pure, survives save / load validation and refuses a hostile palette on load', () => {
    const doc = apply(withPipe(), 'define_palette', PAINT);
    const before = structuredClone(doc);
    execute(doc, 'define_palette', { ...PAINT, replace: true });
    expect(doc).toEqual(before);
    const raw = (display: unknown): Record<string, unknown> => JSON.parse(JSON.stringify({ ...doc, display })) as Record<string, unknown>;
    const stored = doc.display;
    expect(validateDocumentValues(raw(stored))).toEqual([]);
    for (const palettes of [
      [],
      { other: { id: 'acme-paint', name: 'x', colours: {} } },
      { 'acme-paint': { id: 'acme-paint', name: 'x', colours: { green: 'green' } } },
      { 'acme-paint': { id: 'acme-paint', name: 5, colours: {} } },
    ])
      expect(validateDocumentValues(raw({ ...stored, palettes })).length).toBeGreaterThan(0);
  });
});

describe('activating a profile keeps the rest of the display model', () => {
  it('apply_service_colour_scheme activate / define_colour_profile keep palettes, material classes and stored pipe markers', () => {
    let doc = apply(withPipe(), 'define_palette', PAINT);
    doc = apply(doc, 'define_material_class', { id: 'painted', colour: '#ffcc00', metalness: 0.2, roughness: 0.6 });
    doc = apply(doc, 'add_pipe_markers', {});
    const markers = doc.display?.pipeMarkers;
    expect(Object.keys(markers ?? {})).not.toHaveLength(0);
    const active = apply(doc, 'apply_service_colour_scheme', { ...SCHEME, palette: 'acme-paint', activate: true });
    expect(active.display?.activeProfileId).toBe('svc');
    expect(active.display?.palettes?.['acme-paint']).toBeDefined();
    expect(active.display?.materialClasses?.['painted']).toBeDefined();
    expect(active.display?.pipeMarkers).toEqual(markers);
  });
});

/** A port whose signature check records the payload it was asked about, so a test can sign exactly what the command signs. */
function recordingPort(): { port: HumanSignaturePort; ctx: ExecutionContext; seen: () => string } {
  const ledger = ledgerPort();
  let payload = '';
  const port: HumanSignaturePort = {
    ...ledger,
    verify: (confirmation, asked) => {
      payload = asked;
      return ledger.verify(confirmation, asked);
    },
  };
  return { port, ctx: humanCtx(port), seen: () => payload };
}

const signed = (doc: CadDocument, profileId: string, nonce = 'n-1'): { ctx: ExecutionContext; confirmation: Record<string, unknown> } => {
  const probe = recordingPort();
  const first = execute(
    doc,
    'approve_colour_profile',
    { profileId, confirmation: { alg: 'Ed25519', keyId: 'grace', nonce, signature: 'x' } },
    probe.ctx,
  );
  expect(first.error?.code).toBe('VIS_HUMAN_GATE');
  const real = recordingPort();
  return { ctx: real.ctx, confirmation: { alg: 'Ed25519', keyId: 'grace', publicKey: 'ab'.repeat(32), nonce, signature: probe.seen() } };
};

describe('approve_colour_profile', () => {
  const doc = apply(withPipe(), 'apply_service_colour_scheme', { ...SCHEME, activate: true });

  it('an agent (no signature, a bare true, no port) gets VIS_HUMAN_GATE and the document is unchanged', () => {
    expectRefusal(doc, 'approve_colour_profile', { profileId: 'svc' }, 'VIS_HUMAN_GATE', 'confirmation');
    const bare = execute(doc, 'approve_colour_profile', { profileId: 'svc', confirmation: true });
    expect(bare.rejected).toBe(true);
    const unsigned = execute(doc, 'approve_colour_profile', { profileId: 'svc', confirmation: { nonce: 'n', signature: 'x' } }, humanCtx());
    expect(unsigned.error?.code).toBe('VIS_HUMAN_GATE');
    expect(unsigned.document).toBe(doc);
    expect(profile(doc)?.reviewRequired).toBe(true);
  });

  it('a signature over the exact mapping clears reviewRequired, stores the signer, spends once and clears check_display warning', () => {
    const { ctx, confirmation } = signed(doc, 'svc');
    expect(data<{ issues: Array<{ code: string }> }>(doc, 'check_display', {}).issues.map((issue) => issue.code)).toContain(
      'VIS_SCHEME_REVIEW_REQUIRED',
    );
    const out = execute(doc, 'approve_colour_profile', { profileId: 'svc', confirmation }, ctx);
    expect(out.rejected, out.summary).toBeUndefined();
    const approved = profile(out.document);
    expect(approved?.reviewRequired).toBe(false);
    expect(approved?.approval).toMatchObject({ signer: 'grace', signatureId: 'fake:grace' });
    expect(approved?.approval?.profileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.data).toMatchObject({ profileId: 'svc', approval: approved?.approval });
    expect(data<{ issues: Array<{ code: string }> }>(out.document, 'check_display', {}).issues.map((issue) => issue.code)).not.toContain(
      'VIS_SCHEME_REVIEW_REQUIRED',
    );
    const again = execute(doc, 'approve_colour_profile', { profileId: 'svc', confirmation }, ctx);
    expect(again.error?.code).toBe('VIS_HUMAN_GATE');
    expect(validateDocumentValues(JSON.parse(JSON.stringify(out.document)) as Record<string, unknown>)).toEqual([]);
  });

  it('the signature is bound to the mapping, the profile and the document: another mapping, profile or document refuses', () => {
    const { ctx, confirmation } = signed(doc, 'svc');
    const edited = apply(doc, 'apply_service_colour_scheme', { ...SCHEME, serviceMap: { 'cooling water': 'toxic_corrosive' } });
    expect(execute(edited, 'approve_colour_profile', { profileId: 'svc', confirmation }, ctx).error?.code).toBe('VIS_HUMAN_GATE');
    const other = apply(doc, 'apply_service_colour_scheme', { ...SCHEME, profileId: 'other' });
    expect(execute(other, 'approve_colour_profile', { profileId: 'other', confirmation }, humanCtx()).error?.code).toBe('VIS_HUMAN_GATE');
    const elsewhere = apply(createEmptyDocument(), 'add_pipe_run', {
      points: [
        [5, 5, 0],
        [900, 5, 0],
      ],
      dn: 50,
      service: 'cooling water',
    });
    const copy = apply(elsewhere, 'apply_service_colour_scheme', SCHEME);
    expect(execute(copy, 'approve_colour_profile', { profileId: 'svc', confirmation }, humanCtx()).error?.code).toBe('VIS_HUMAN_GATE');
  });

  it('refuses an unknown profile, leaves a profile that awaits no review alone (nothing spent), and re-applying removes the approval', () => {
    expectRefusal(doc, 'approve_colour_profile', { profileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND', 'profileId');
    expectRefusal(createEmptyDocument(), 'approve_colour_profile', { profileId: 'constructor' }, 'CMD_RESERVED_ID');
    const plain = apply(doc, 'define_colour_profile', {
      id: 'plain',
      name: 'Plain',
      rules: [{ id: 'r', when: { property: 'kind', equals: 'pipe' }, colour: '#112233', legend: 'x' }],
    });
    const noop = execute(plain, 'approve_colour_profile', { profileId: 'plain' });
    expect(noop.rejected).toBeUndefined();
    expect(noop.document).toBe(plain);
    expect(noop.affected).toEqual([]);
    const { ctx, confirmation } = signed(doc, 'svc');
    const approved = execute(doc, 'approve_colour_profile', { profileId: 'svc', confirmation }, ctx).document;
    const reapplied = apply(approved, 'apply_service_colour_scheme', SCHEME);
    expect(profile(reapplied)).toMatchObject({ reviewRequired: true });
    expect(profile(reapplied)?.approval).toBeUndefined();
  });

  it('is pure and a hostile approval on load is refused', () => {
    const before = structuredClone(doc);
    execute(doc, 'approve_colour_profile', { profileId: 'svc' });
    expect(doc).toEqual(before);
    const bad = JSON.parse(
      JSON.stringify({ ...doc, display: { ...doc.display, colourProfiles: { svc: { ...profile(doc), approval: { signer: 1 } } } } }),
    ) as Record<string, unknown>;
    expect(validateDocumentValues(bad).length).toBeGreaterThan(0);
  });
});

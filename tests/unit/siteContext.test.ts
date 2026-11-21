import { describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { parseIsoWithOffset, solarPosition, sunDirection } from '@lib/solarPosition';
import { sunAt } from '@core/model/siteContext';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

const SITE = { latitudeDeg: 48.2, longitudeDeg: 16.37, dateTime: '2026-06-21T14:30:00+02:00' };
const withSite = (doc = createEmptyDocument()): CadDocument => execute(doc, 'set_site_context', SITE).document;

describe('solar position (NOAA equations)', () => {
  it('matches the NREL SPA paper test case (Reda & Andreas 2003: Golden CO, 2003-10-17 12:30:30 UTC-7)', () => {
    const when = parseIsoWithOffset('2003-10-17T12:30:30-07:00');
    expect(when).not.toBeNull();
    const p = solarPosition(39.742476, -105.1786, when!);
    // SPA topocentric: zenith 50.11162 deg (elevation 39.88838), azimuth 194.34024 deg east of north.
    expect(Math.abs(p.azimuthDeg - 194.34024)).toBeLessThan(0.02);
    expect(Math.abs(p.elevationDeg - 39.88838)).toBeLessThan(0.02);
  });
  it('gives the solstice declination, polar day and polar night', () => {
    const noon = solarPosition(0, 0, parseIsoWithOffset('2026-06-21T12:00:00Z')!);
    expect(noon.declinationDeg).toBeGreaterThan(23.4);
    expect(noon.declinationDeg).toBeLessThan(23.5);
    expect(solarPosition(78, 15, parseIsoWithOffset('2026-06-21T00:00:00+01:00')!).elevationDeg).toBeGreaterThan(0);
    expect(solarPosition(78, 15, parseIsoWithOffset('2026-12-21T12:00:00+01:00')!).elevationDeg).toBeLessThan(0);
  });
  it('puts the equinox sun overhead at the equator at solar noon and due east in the morning', () => {
    const noon = solarPosition(0, 0, parseIsoWithOffset('2026-03-20T12:00:00Z')!);
    expect(noon.geometricElevationDeg).toBeGreaterThan(85);
    const morning = solarPosition(0, 0, parseIsoWithOffset('2026-03-20T06:00:00Z')!);
    expect(Math.abs(morning.azimuthDeg - 90)).toBeLessThan(2);
    expect(Math.abs(morning.geometricElevationDeg)).toBeLessThan(5);
  });
  it('is deterministic and independent of how the offset is written', () => {
    const a = solarPosition(10, 20, parseIsoWithOffset('2026-05-01T12:00:00+02:00')!);
    const b = solarPosition(10, 20, parseIsoWithOffset('2026-05-01T10:00:00Z')!);
    expect(a).toEqual(b);
  });
  it('covers the refraction branches (high, mid, near horizon, below)', () => {
    const elevations = ['06:00', '06:30', '07:30', '10:00', '12:00'].map(
      (t) => solarPosition(0, 0, parseIsoWithOffset(`2026-03-20T${t}:00Z`)!).elevationDeg,
    );
    expect(elevations.every(Number.isFinite)).toBe(true);
    const below = solarPosition(0, 0, parseIsoWithOffset('2026-03-20T03:00:00Z')!);
    expect(below.elevationDeg).toBeLessThan(0);
    const near = solarPosition(0, 0, parseIsoWithOffset('2026-03-20T05:55:00Z')!);
    expect(near.elevationDeg).toBeGreaterThan(near.geometricElevationDeg);
  });
  it('parses only ISO-8601 with an explicit offset and a real calendar date', () => {
    expect(parseIsoWithOffset('2026-06-21T14:30')).toBeNull();
    expect(parseIsoWithOffset('2026-06-21T14:30:00')).toBeNull();
    expect(parseIsoWithOffset('2026-02-29T12:00:00Z')).toBeNull();
    expect(parseIsoWithOffset('2028-02-29T12:00:00Z')).not.toBeNull();
    expect(parseIsoWithOffset('2026-06-21T24:00:00Z')).toBeNull();
    expect(parseIsoWithOffset('2026-06-21T12:00:00+15:00')).toBeNull();
    expect(parseIsoWithOffset('2026-06-21T12:00:00+02:75')).toBeNull();
    expect(parseIsoWithOffset('2026-06-21T12:00:00-03:30')?.offsetMinutes).toBe(-210);
    expect(parseIsoWithOffset('nope')).toBeNull();
  });
  it('rotates the sun by the north angle (counter-clockwise from +Y)', () => {
    expect(sunDirection(90, 0, 0)[0]).toBeCloseTo(1, 9);
    const rotated = sunDirection(0, 0, 90);
    expect(rotated[0]).toBeCloseTo(-1, 9);
    expect(rotated[1]).toBeCloseTo(0, 9);
    expect(sunDirection(0, 90, 33)[2]).toBeCloseTo(1, 9);
  });
});

describe('set_site_context / clear_site_context / sun_position', () => {
  it('stores the site, defaults the north angle and names the sun', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_site_context', { ...SITE, groundElevation: 170 });
    expect(result.affected).toEqual([]);
    expect(result.document.siteContext).toEqual({ ...SITE, northAngleDeg: 0, groundElevation: 170 });
    expect(result.summary).toContain('Site context set');
    expect(result.summary).toContain('elevation');
    expect(doc.siteContext).toBeUndefined();
  });
  it('replaces a previous site and flags a night time', () => {
    const night = execute(withSite(), 'set_site_context', { ...SITE, dateTime: '2026-06-21T00:30:00+02:00', northAngleDeg: 20 });
    expect(night.document.siteContext?.northAngleDeg).toBe(20);
    expect(night.summary).toContain('below the horizon');
  });
  it('is pure', () => {
    const doc = withSite();
    expectPure(doc, () => {
      execute(doc, 'set_site_context', { ...SITE, latitudeDeg: 10 });
      execute(doc, 'clear_site_context', {});
      execute(doc, 'sun_position', {});
    });
  });
  it('rejects out-of-range angles and offset-less or impossible date-times without changing the document', () => {
    const doc = createEmptyDocument();
    for (const bad of [
      { ...SITE, latitudeDeg: 91 },
      { ...SITE, longitudeDeg: -181 },
      { ...SITE, dateTime: '2026-06-21T14:30:00' },
      { ...SITE, dateTime: '2026-13-01T00:00:00Z' },
      { ...SITE, dateTime: 'now' },
    ]) {
      expectNoOp(execute(doc, 'set_site_context', bad), doc);
    }
    const impossible = execute(doc, 'set_site_context', { ...SITE, dateTime: '2026-02-30T10:00:00Z' });
    expect(impossible.summary).toContain('explicit UTC offset');
  });
  it('clears the site, and is a no-op without one', () => {
    const cleared = execute(withSite(), 'clear_site_context', {});
    expect('siteContext' in cleared.document).toBe(false);
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'clear_site_context', {}), empty, 'No site context');
  });
  it('sun_position reads the stored site, or a given date-time, and returns the unchanged document', () => {
    const doc = withSite();
    const stored = execute(doc, 'sun_position', {});
    expect(stored.document).toBe(doc);
    const data = stored.data as { azimuthDeg: number; up: boolean; direction: [number, number, number] };
    expect(data.azimuthDeg).toBe(sunAt(doc.siteContext!)!.azimuthDeg);
    expect(data.up).toBe(true);
    expect(Math.hypot(...data.direction)).toBeCloseTo(1, 9);
    const night = execute(doc, 'sun_position', { dateTime: '2026-06-21T01:00:00+02:00', northAngleDeg: 90 });
    expect((night.data as { up: boolean }).up).toBe(false);
    expect((night.data as { planAzimuthDeg: number }).planAzimuthDeg).toBeGreaterThanOrEqual(0);
    expect(night.summary).toContain('below the horizon');
  });
  it('sun_position works without a stored site when latitude, longitude and date-time are given, else is a no-op', () => {
    const empty = createEmptyDocument();
    const given = execute(empty, 'sun_position', { latitudeDeg: 0, longitudeDeg: 0, dateTime: '2026-03-20T12:00:00Z' });
    expect((given.data as { elevationDeg: number }).elevationDeg).toBeGreaterThan(85);
    expectNoOp(execute(empty, 'sun_position', {}), empty, 'no site context');
    const doc = withSite();
    expectNoOp(execute(doc, 'sun_position', { dateTime: 'tomorrow' }), doc, 'ISO-8601');
  });
  it('round-trips through a saved file and refuses a corrupt site on load', () => {
    const doc = withSite();
    expect(deserializeDocument(serializeDocument(doc)).siteContext).toEqual(doc.siteContext);
    const envelope = (siteContext: unknown): string =>
      JSON.stringify({ format: 'llull-document', version: 3, document: { ...createEmptyDocument(), siteContext } });
    const good = { ...SITE, northAngleDeg: 0 };
    for (const bad of [
      3,
      { ...good, latitudeDeg: 99 },
      { ...good, dateTime: '2026-06-21T14:30' },
      { ...good, northAngleDeg: 'x' },
      { ...good, longitudeDeg: 400 },
    ])
      expect(() => deserializeDocument(envelope(bad))).toThrow(/siteContext/);
    expect(() => deserializeDocument(envelope({ ...good, groundElevation: 'high' }))).toThrow(/groundElevation/);
  });
});

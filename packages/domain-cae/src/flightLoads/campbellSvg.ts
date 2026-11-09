/** Campbell diagram of check_rotor_resonance as deterministic SVG text: rpm (x) against Hz (y), mode lines, k.rpm/60 rays, shaded operating bands. */

import { excitationHz } from './campbellMath';

export interface CampbellInput {
  readonly modes: readonly { readonly mode: number; readonly frequencyHz: number }[];
  readonly harmonics: readonly { readonly label: string; readonly harmonic: number }[];
  readonly bands: readonly { readonly rotorId: string; readonly lowRpm: number; readonly highRpm: number }[];
  readonly crossings: readonly { readonly rpm: number; readonly frequencyHz: number }[];
}

export const CAMPBELL_WIDTH = 800;
const HEIGHT = 520;
const LEFT = 70;
const RIGHT = 150;
const TOP = 40;
const BOTTOM = 60;

const fixed = (value: number): string => value.toFixed(2);
const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Round an axis end up to 1, 2 or 5 x 10^n. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const mantissa = value / power;
  return (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * power;
}

/** The chart; every number is formatted to two decimals so equal input gives byte-equal text. */
export function campbellSvg(input: CampbellInput, title: string): string {
  const rpmMax = niceCeil(Math.max(0, ...input.bands.map((band) => band.highRpm)) * 1.1);
  const rayEnd = Math.max(0, ...input.harmonics.map((entry) => excitationHz(entry.harmonic, rpmMax)));
  const frequencyMax = niceCeil(rayEnd > 0 ? rayEnd : Math.max(0, ...input.modes.map((mode) => mode.frequencyHz)) * 1.1);
  const plotWidth = CAMPBELL_WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const x = (rpm: number): number => LEFT + (rpm / rpmMax) * plotWidth;
  const y = (hz: number): number => TOP + plotHeight - (hz / frequencyMax) * plotHeight;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAMPBELL_WIDTH}" height="${HEIGHT}" viewBox="0 0 ${CAMPBELL_WIDTH} ${HEIGHT}" font-family="sans-serif" font-size="11">`,
    `<rect width="${CAMPBELL_WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    `<text x="${LEFT}" y="22" font-size="14">${escapeText(title)}</text>`,
  ];
  input.bands.forEach((band, index) =>
    out.push(
      `<rect x="${fixed(x(band.lowRpm))}" y="${TOP}" width="${fixed(Math.max(1, x(band.highRpm) - x(band.lowRpm)))}" height="${plotHeight}" fill="#4a90d9" fill-opacity="0.15"/>`,
      `<text x="${fixed(x(band.lowRpm) + 3)}" y="${TOP + 12 + index * 12}" fill="#2a5a99">${escapeText(band.rotorId)} band</text>`,
    ),
  );
  for (let tick = 0; tick <= 5; tick += 1) {
    const rpm = (rpmMax * tick) / 5;
    const hz = (frequencyMax * tick) / 5;
    out.push(
      `<line x1="${fixed(x(rpm))}" y1="${TOP}" x2="${fixed(x(rpm))}" y2="${TOP + plotHeight}" stroke="#dddddd"/>`,
      `<text x="${fixed(x(rpm))}" y="${TOP + plotHeight + 16}" text-anchor="middle">${Math.round(rpm)}</text>`,
      `<line x1="${LEFT}" y1="${fixed(y(hz))}" x2="${LEFT + plotWidth}" y2="${fixed(y(hz))}" stroke="#dddddd"/>`,
      `<text x="${LEFT - 6}" y="${fixed(y(hz) + 4)}" text-anchor="end">${Number(hz.toPrecision(4))}</text>`,
    );
  }
  out.push(
    `<rect x="${LEFT}" y="${TOP}" width="${plotWidth}" height="${plotHeight}" fill="none" stroke="#333333"/>`,
    `<text x="${LEFT + plotWidth / 2}" y="${HEIGHT - 14}" text-anchor="middle">rotor speed, rpm</text>`,
    `<text x="16" y="${TOP + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${TOP + plotHeight / 2})">frequency, Hz</text>`,
  );
  for (const mode of input.modes.filter((entry) => entry.frequencyHz > 0 && entry.frequencyHz <= frequencyMax))
    out.push(
      `<line x1="${LEFT}" y1="${fixed(y(mode.frequencyHz))}" x2="${LEFT + plotWidth}" y2="${fixed(y(mode.frequencyHz))}" stroke="#1b7f3b" stroke-width="1.5"/>`,
      `<text x="${LEFT + plotWidth + 4}" y="${fixed(y(mode.frequencyHz) + 4)}" fill="#1b7f3b">mode ${mode.mode} ${Number(mode.frequencyHz.toPrecision(5))} Hz</text>`,
    );
  for (const entry of input.harmonics) {
    const end = Math.min(rpmMax, (60 * frequencyMax) / entry.harmonic);
    out.push(
      `<line x1="${fixed(x(0))}" y1="${fixed(y(0))}" x2="${fixed(x(end))}" y2="${fixed(y(excitationHz(entry.harmonic, end)))}" stroke="#c0392b" stroke-dasharray="6 3"/>`,
      `<text x="${fixed(x(end) - 4)}" y="${fixed(y(excitationHz(entry.harmonic, end)) - 4)}" text-anchor="end" fill="#c0392b">${escapeText(entry.label)}</text>`,
    );
  }
  for (const point of input.crossings)
    if (point.rpm <= rpmMax && point.frequencyHz <= frequencyMax)
      out.push(`<circle cx="${fixed(x(point.rpm))}" cy="${fixed(y(point.frequencyHz))}" r="4" fill="#000000"/>`);
  out.push('</svg>');
  return out.join('\n');
}

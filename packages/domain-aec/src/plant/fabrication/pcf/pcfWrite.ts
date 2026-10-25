/**
 * Canonical PCF writer (plant 05 ISO §5.2, TR-ISO-02). Header in fixed order, `PIPELINE-REFERENCE` with its attributes in fixed order, one record per
 * component in flow order with 1-based `COMPONENT-IDENTIFIER`, then `MATERIALS`. Component attributes: COMPONENT-IDENTIFIER, UNIQUE-COMPONENT-IDENTIFIER
 * (llull ids only), END-POINTs, CENTRE-POINT, BRANCH1-POINT, CO-ORDS, the unknown attributes in stored order, SKEY, the category flag, ITEM-CODE, WEIGHT.
 * Numbers: millimetres with one decimal (`-0.0` is `0.0`), inches with four; bores shortest decimal. No TAB; a line over 1024 characters is cut and counted.
 * Pure and byte-deterministic: the same data gives the same bytes.
 */

import type { Vec3 } from '@core/model/vectors';
import type { NetworkComponent, NetworkPoint, PcfLineData } from '../model';
import { MAX_PCF_LINE } from './pcfLexer';

export interface PcfWriteOptions {
  readonly units: 'mm' | 'inch';
  readonly includeMaterials: boolean;
}

export interface PcfWritten {
  readonly content: string;
  /** Lines cut to 1024 characters (1-based line numbers of the output). */
  readonly truncatedLines: readonly number[];
}

const MM_PER_INCH = 25.4;
const WELD_SKEYS = { shop: 'WW', site: 'WS', field_fit: 'WF' } as const;
const PIPELINE_ORDER = [
  'PIPING-SPEC',
  'INSULATION-SPEC',
  'TRACING-SPEC',
  'PAINTING-SPEC',
  'PROJECT-IDENTIFIER',
  'AREA',
  'REVISION',
  'DATE-DMY',
  'SPOOL-PREFIX',
  'WELD-PREFIX-FABRICATION',
  'WELD-PREFIX-ERECTION',
  'HIGHEST-WELD-NUMBER',
  'HIGHEST-SPOOL-NUMBER',
] as const;
const CATEGORY_KEYS = { fabrication: 'FABRICATION-ITEM', erection: 'ERECTION-ITEM', offshore: 'OFFSHORE-ITEM' } as const;

const entry = (key: string, value: string): string => (value === '' ? `    ${key}` : `    ${key} ${value}`);

function formatters(units: PcfWriteOptions['units']): { coordinate: (mm: number) => string; bore: (mm: number) => string } {
  const inch = units === 'inch';
  const decimals = inch ? 4 : 1;
  const scale = inch ? 1 / MM_PER_INCH : 1;
  return {
    coordinate: (mm) => {
      const text = (mm * scale).toFixed(decimals);
      return /^-0\.0+$/.test(text) ? text.slice(1) : text;
    },
    bore: (mm) => String(Math.round(mm * scale * (inch ? 10_000 : 100)) / (inch ? 10_000 : 100)),
  };
}

function componentLines(component: NetworkComponent, position: number, fmt: ReturnType<typeof formatters>): string[] {
  const xyz = (value: Vec3): string => value.map(fmt.coordinate).join(' ');
  const withBore = (key: string, p: NetworkPoint): string =>
    `    ${key} ${xyz(p.xyz)} ${fmt.bore(p.boreMm)}${p.endType === undefined ? '' : ` ${p.endType}`}`;
  const lines = [component.type, `    COMPONENT-IDENTIFIER ${position}`];
  if (!component.id.startsWith('pcf:')) lines.push(`    UNIQUE-COMPONENT-IDENTIFIER ${component.id}`);
  for (const end of component.ends) lines.push(withBore('END-POINT', end));
  if (component.centre !== undefined) lines.push(`    CENTRE-POINT ${xyz(component.centre)}`);
  if (component.branch !== undefined) lines.push(withBore('BRANCH1-POINT', component.branch));
  if (component.coords !== undefined) lines.push(`    CO-ORDS ${xyz(component.coords)}`);
  for (const [key, value] of Object.entries(component.extra ?? {})) lines.push(entry(key, value));
  const skey = component.skey ?? (component.weldKind === undefined ? undefined : WELD_SKEYS[component.weldKind]);
  if (skey !== undefined) lines.push(`    SKEY ${skey}`);
  if (component.category !== undefined) lines.push(`    ${CATEGORY_KEYS[component.category]}`);
  if (component.itemCode !== undefined) lines.push(`    ITEM-CODE ${component.itemCode}`);
  if (component.weightKg !== undefined) lines.push(`    WEIGHT ${component.weightKg}`);
  return lines;
}

function headerLines(data: PcfLineData, unit: 'MM' | 'INCH'): string[] {
  const rest = Object.entries(data.header).filter(
    ([key]) => key !== 'ISOGEN-FILES' && key !== 'UNITS-WEIGHT' && key !== 'UNITS-WEIGHT-LENGTH',
  );
  return [
    `ISOGEN-FILES ${data.header['ISOGEN-FILES'] ?? 'ISOGEN.FLS'}`,
    `UNITS-BORE ${unit}`,
    `UNITS-CO-ORDS ${unit}`,
    ...(data.header['UNITS-WEIGHT'] === undefined ? [] : [`UNITS-WEIGHT ${data.header['UNITS-WEIGHT']}`]),
    `UNITS-BOLT-DIA ${unit}`,
    `UNITS-BOLT-LENGTH ${unit}`,
    ...(data.header['UNITS-WEIGHT-LENGTH'] === undefined ? [] : [`UNITS-WEIGHT-LENGTH ${data.header['UNITS-WEIGHT-LENGTH']}`]),
    ...rest.map(([key, value]) => `${key} ${value}`.trimEnd()),
  ];
}

/** The PCF text of one line, with `unknownRecords` back at their positions. */
export function writePcfText(data: PcfLineData, options: PcfWriteOptions): PcfWritten {
  const fmt = formatters(options.units);
  const out: string[] = headerLines(data, options.units === 'inch' ? 'INCH' : 'MM');
  out.push(`PIPELINE-REFERENCE ${data.lineId}`);
  const known = PIPELINE_ORDER.filter((key) => key in data.attributes);
  const others = Object.keys(data.attributes).filter((key) => !(PIPELINE_ORDER as readonly string[]).includes(key));
  for (const key of [...known, ...others]) out.push(entry(key, data.attributes[key] ?? ''));
  const unknownAt = (after: number): string[] =>
    data.unknownRecords.filter((record) => record.after === after).flatMap((record) => record.text);
  out.push(...unknownAt(0));
  data.components.forEach((component, index) => {
    out.push(...componentLines(component, index + 1, fmt), ...unknownAt(index + 1));
  });
  if (options.includeMaterials && data.materials.length > 0) {
    out.push('MATERIALS');
    for (const material of data.materials) {
      out.push(`ITEM-CODE ${material.itemCode}`);
      for (const [key, value] of Object.entries(material.fields)) out.push(entry(key, value));
    }
  }
  const truncatedLines: number[] = [];
  const cut = out.map((text, index) => {
    if (text.length <= MAX_PCF_LINE) return text;
    truncatedLines.push(index + 1);
    return text.slice(0, MAX_PCF_LINE).trimEnd();
  });
  return { content: `${cut.join('\n')}\n`, truncatedLines };
}

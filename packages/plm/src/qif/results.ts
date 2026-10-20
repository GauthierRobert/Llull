/** QIF 3.0 MeasurementResults reader (M6, VC-PLM-24): the characteristic measurements of a QIF file, from the XSD of QIF 3.0 (ANSI/DMSC QIF 3.0-2018). */

import type { FaiResultStatus } from '@core/model/plm';
import { type XmlLimits, type XmlNode, parseXml } from './xml';

const QIF3_NAMESPACE = 'http://qifstandards.org/xsd/qif3';
const STATUSES: ReadonlySet<string> = new Set([
  'PASS',
  'FAIL',
  'REWORK',
  'SYSERROR',
  'INDETERMINATE',
  'NOT_ANALYZED',
  'BASIC_OR_TED',
  'UNDEFINED',
]);
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_MEASUREMENTS = 100_000;

interface QifMeasurement {
  /** The `id` attribute of the measurement element. */
  readonly qifId: string;
  /** Element name, e.g. `DiameterCharacteristicMeasurement`. */
  readonly element: string;
  /** `CharacteristicItemId`: the QIF id of the characteristic item measured. */
  readonly itemId: string;
  readonly status: FaiResultStatus;
  readonly value?: number;
  readonly maxValue?: number;
  readonly unit?: string;
}

export type QifRead =
  | {
      readonly ok: true;
      readonly measurements: readonly QifMeasurement[];
      /** QIF item id -> the item's `Name` (the balloon number printed on the drawing, by the QIF authoring convention) when the file carries the item. */
      readonly itemNames: ReadonlyMap<string, string>;
      readonly elements: number;
    }
  | { readonly ok: false; readonly code: 'PLM_QIF_INVALID' | 'PLM_QIF_LIMIT'; readonly message: string };

const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((candidate) => candidate.name === name);

/** Every descendant of `root` (iterative, document order) satisfying `test`. */
function find(root: XmlNode, test: (node: XmlNode) => boolean): XmlNode[] {
  const found: XmlNode[] = [];
  const pending: XmlNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as XmlNode;
    if (test(node)) found.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index] as XmlNode);
  }
  return found;
}

function numberOf(node: XmlNode | undefined, what: string): { readonly value?: number } | string {
  if (node === undefined) return {};
  const text = node.text.trim();
  if (!DECIMAL.test(text)) return `line ${node.line}: ${what} '${text.slice(0, 40)}' is not a number`;
  const value = Number(text);
  return Number.isFinite(value) ? { value } : `line ${node.line}: ${what} is not finite`;
}

function statusOf(measurement: XmlNode): FaiResultStatus {
  const status = child(measurement, 'Status');
  const named = status === undefined ? undefined : child(status, 'CharacteristicStatusEnum')?.text.trim();
  return named !== undefined && STATUSES.has(named) ? (named as FaiResultStatus) : 'OTHER';
}

/**
 * The characteristic measurements of a QIF 3 file. Refuses a file that is not QIF 3 (root element and namespace), is not well-formed or exceeds the limits.
 * @invariant pure and linear in the file; the status is the measuring system's verdict as written, never recomputed
 */
export function readQifResults(xml: string, limits?: XmlLimits): QifRead {
  const parsed = limits === undefined ? parseXml(xml) : parseXml(xml, limits);
  if (!parsed.ok) return parsed;
  const { root } = parsed;
  if (root.name !== 'QIFDocument')
    return { ok: false, code: 'PLM_QIF_INVALID', message: `the root element is <${root.name}>, not <QIFDocument>` };
  const namespaces = Object.entries(root.attrs).filter(([key]) => key === 'xmlns' || key.startsWith('xmlns:'));
  if (!namespaces.some(([, uri]) => uri === QIF3_NAMESPACE))
    return {
      ok: false,
      code: 'PLM_QIF_INVALID',
      message: `not a QIF 3 file: the namespace is ${namespaces[0]?.[1] ?? 'missing'}, expected ${QIF3_NAMESPACE}`,
    };
  const itemNames = new Map<string, string>();
  for (const items of find(root, (node) => node.name === 'CharacteristicItems'))
    for (const item of items.children) {
      const name = child(item, 'Name')?.text.trim();
      const id = item.attrs['id'];
      if (id !== undefined && name !== undefined && name !== '') itemNames.set(id, name);
    }
  const linearUnit = find(root, (node) => node.name === 'FileUnits')
    .map((units) => child(child(child(units, 'PrimaryUnits') ?? units, 'LinearUnit') ?? units, 'UnitName')?.text.trim())
    .find((name) => name !== undefined && name !== '');
  const measurements: QifMeasurement[] = [];
  for (const set of find(root, (node) => node.name === 'CharacteristicMeasurements'))
    for (const node of set.children) {
      if (!node.name.endsWith('CharacteristicMeasurement')) continue;
      if (measurements.length >= MAX_MEASUREMENTS)
        return { ok: false, code: 'PLM_QIF_LIMIT', message: `more than ${MAX_MEASUREMENTS} characteristic measurements` };
      const itemId = child(node, 'CharacteristicItemId')?.text.trim();
      if (itemId === undefined || itemId === '')
        return { ok: false, code: 'PLM_QIF_INVALID', message: `line ${node.line}: <${node.name}> has no CharacteristicItemId` };
      const valueNode = child(node, 'Value');
      const value = numberOf(valueNode, 'Value');
      const max = numberOf(child(node, 'MaxValue'), 'MaxValue');
      if (typeof value === 'string') return { ok: false, code: 'PLM_QIF_INVALID', message: value };
      if (typeof max === 'string') return { ok: false, code: 'PLM_QIF_INVALID', message: max };
      const unit =
        valueNode?.attrs['linearUnit'] ??
        valueNode?.attrs['angularUnit'] ??
        (valueNode?.attrs['angularUnit'] === undefined ? linearUnit : undefined);
      measurements.push({
        qifId: node.attrs['id'] ?? '',
        element: node.name,
        itemId,
        status: statusOf(node),
        ...(value.value !== undefined ? { value: value.value } : {}),
        ...(max.value !== undefined ? { maxValue: max.value } : {}),
        ...(unit !== undefined && value.value !== undefined ? { unit } : {}),
      });
    }
  if (measurements.length === 0)
    return {
      ok: false,
      code: 'PLM_QIF_INVALID',
      message: 'the file holds no characteristic measurements (MeasurementResults / MeasuredCharacteristics / CharacteristicMeasurements)',
    };
  return { ok: true, measurements, itemNames, elements: parsed.elements };
}

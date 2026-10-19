// 3Dconnexion SpaceMouse HID input reports -> raw axis values. Pure: bytes in, numbers out.
//
// WebHID hands over each report WITHOUT its report-id byte. Report layouts (little-endian int16, ~-350..350 nominal travel):
//   id 1: translation x, y, z (6 bytes)  - on newer devices a combined 6-axis report: x, y, z, rx, ry, rz (12 bytes)
//   id 2: rotation rx, ry, rz (6 bytes)
//   id 3: button bitmask (little-endian, 1-4 bytes)
// x right, y toward the user (push = negative), z up/down (pull up = negative); rx tilt forward/back, ry roll, rz twist.

export const SPACE_MOUSE_VENDOR_IDS: readonly number[] = [0x256f, 0x046d];

/** Nominal full-deflection reading; values are normalised by it and clamped to -1..1. */
const FULL_DEFLECTION = 350;

type Axes3 = readonly [number, number, number];

export type SpaceMouseReport =
  | { type: 'translation'; values: Axes3 }
  | { type: 'rotation'; values: Axes3 }
  | { type: 'motion'; translation: Axes3; rotation: Axes3 }
  | { type: 'buttons'; mask: number };

const REPORT_TRANSLATION = 1;
const REPORT_ROTATION = 2;
const REPORT_BUTTONS = 3;

const normalise = (raw: number): number => Math.max(-1, Math.min(1, raw / FULL_DEFLECTION));

function readAxes(view: DataView, offset: number): Axes3 {
  return [normalise(view.getInt16(offset, true)), normalise(view.getInt16(offset + 2, true)), normalise(view.getInt16(offset + 4, true))];
}

/** @pure */
export function parseSpaceMouseReport(reportId: number, bytes: Uint8Array): SpaceMouseReport | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (reportId) {
    case REPORT_TRANSLATION:
      if (bytes.byteLength >= 12) return { type: 'motion', translation: readAxes(view, 0), rotation: readAxes(view, 6) };
      return bytes.byteLength >= 6 ? { type: 'translation', values: readAxes(view, 0) } : null;
    case REPORT_ROTATION:
      return bytes.byteLength >= 6 ? { type: 'rotation', values: readAxes(view, 0) } : null;
    case REPORT_BUTTONS: {
      let mask = 0;
      for (let index = 0; index < Math.min(bytes.byteLength, 4); index += 1) mask += (bytes[index] ?? 0) * 2 ** (8 * index);
      return { type: 'buttons', mask };
    }
    default:
      return null;
  }
}

/** Latest axis values of the device; reports update only their own half. */
export interface SpaceMouseAxes {
  translation: Axes3;
  rotation: Axes3;
}

export const REST_AXES: SpaceMouseAxes = { translation: [0, 0, 0], rotation: [0, 0, 0] };

/** @pure */
export function mergeReport(axes: SpaceMouseAxes, report: SpaceMouseReport): SpaceMouseAxes {
  switch (report.type) {
    case 'translation':
      return { ...axes, translation: report.values };
    case 'rotation':
      return { ...axes, rotation: report.values };
    case 'motion':
      return { translation: report.translation, rotation: report.rotation };
    case 'buttons':
      return axes;
  }
}

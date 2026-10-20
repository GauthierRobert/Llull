// Thin WebHID glue for 3Dconnexion devices (Electron renderer; the main process grants the HID permission, see desktop/src/hid.ts).
// All decoding lives in the pure spaceMouseReports module; this file only opens a device and forwards its input reports.
// Linux spacenavd is not supported: WebHID reads the hidraw node directly, which spacenavd/udev may hold - see docs/UI.md.

import { SPACE_MOUSE_VENDOR_IDS, type SpaceMouseReport, parseSpaceMouseReport } from './spaceMouseReports';

interface HidInputReportEvent {
  reportId: number;
  data: DataView;
}

export interface HidDeviceLike {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HidInputReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: HidInputReportEvent) => void): void;
}

interface HidApi {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: { filters: ReadonlyArray<{ vendorId: number; usagePage: number; usage: number }> }): Promise<HidDeviceLike[]>;
}

/** Generic Desktop page, Multi-axis Controller usage: what a SpaceMouse reports (keeps Logitech mice out of the 0x046d picker). */
const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
const USAGE_MULTI_AXIS = 0x08;

/** The browser's WebHID entry point, or null when absent (web build, jsdom, old Electron). */
export function hidApi(): HidApi | null {
  const hid = (globalThis.navigator as unknown as { hid?: HidApi } | undefined)?.hid;
  return hid ?? null;
}

const isSpaceMouse = (device: Pick<HidDeviceLike, 'vendorId'>): boolean => SPACE_MOUSE_VENDOR_IDS.includes(device.vendorId);

/** Devices the user already granted (no prompt). */
export async function grantedSpaceMice(api: HidApi): Promise<HidDeviceLike[]> {
  return (await api.getDevices()).filter(isSpaceMouse);
}

/** Needs a user gesture: shows the device picker. */
export async function requestSpaceMice(api: HidApi): Promise<HidDeviceLike[]> {
  return api.requestDevice({
    filters: SPACE_MOUSE_VENDOR_IDS.map((vendorId) => ({ vendorId, usagePage: USAGE_PAGE_GENERIC_DESKTOP, usage: USAGE_MULTI_AXIS })),
  });
}

/** Opens the device and forwards decoded reports; the returned function stops listening and closes it. */
export async function listenToSpaceMouse(device: HidDeviceLike, onReport: (report: SpaceMouseReport) => void): Promise<() => void> {
  if (!device.opened) await device.open();
  const listener = (event: HidInputReportEvent): void => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const report = parseSpaceMouseReport(event.reportId, bytes);
    if (report !== null) onReport(report);
  };
  device.addEventListener('inputreport', listener);
  return () => {
    device.removeEventListener('inputreport', listener);
    void device.close().catch(() => undefined);
  };
}

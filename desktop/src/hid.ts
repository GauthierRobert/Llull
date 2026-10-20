/**
 * WebHID policy for the app window (3D mouse, SC-A3): only 3Dconnexion devices (vendor 0x256f, or Logitech's 0x046d under which older
 * SpaceMice enumerate) that report as a multi-axis controller, and only for the app's own origin. Anything else stays denied, so a page
 * can never read a keyboard or another HID device.
 */

const SPACE_MOUSE_VENDOR_IDS: readonly number[] = [0x256f, 0x046d];

const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
const USAGE_MULTI_AXIS_CONTROLLER = 0x08;

export interface HidDeviceInfo {
  deviceId: string;
  vendorId: number;
  productId?: number;
  name?: string;
  /** Top-level collections; absent on some platforms, in which case the vendor check alone applies. */
  collections?: ReadonlyArray<{ usagePage: number; usage: number }>;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A device the app may talk to. */
export function isSpaceMouseDevice(device: Pick<HidDeviceInfo, 'vendorId' | 'collections'>): boolean {
  if (!SPACE_MOUSE_VENDOR_IDS.includes(device.vendorId)) return false;
  const collections = device.collections;
  if (collections === undefined || collections.length === 0) return true;
  return collections.some((c) => c.usagePage === USAGE_PAGE_GENERIC_DESKTOP && c.usage === USAGE_MULTI_AXIS_CONTROLLER);
}

/** `setDevicePermissionHandler`: HID access for the app origin and 3D mice only. */
export function hidDevicePermitted(details: { deviceType: string; origin: string; device: HidDeviceInfo }, appOrigin: string): boolean {
  return details.deviceType === 'hid' && originOf(details.origin) === appOrigin && isSpaceMouseDevice(details.device);
}

/** `select-hid-device`: the device id to grant from the picker's list (first 3D mouse), or '' to cancel the request. */
export function pickSpaceMouse(deviceList: readonly HidDeviceInfo[]): string {
  return deviceList.find(isSpaceMouseDevice)?.deviceId ?? '';
}

import { describe, expect, it } from 'vitest';
import { hidDevicePermitted, isSpaceMouseDevice, pickSpaceMouse } from '../src/hid';
import { permissionAllowed } from '../src/navigation';

const ORIGIN = 'http://127.0.0.1:47827';
const spaceMouse = { deviceId: 'a', vendorId: 0x256f, collections: [{ usagePage: 1, usage: 8 }] };
const logitechMouse = { deviceId: 'b', vendorId: 0x046d, collections: [{ usagePage: 1, usage: 2 }] };
const keyboard = { deviceId: 'c', vendorId: 0x1234, collections: [{ usagePage: 1, usage: 6 }] };

describe('3D mouse HID policy', () => {
  it('accepts 3Dconnexion multi-axis controllers only', () => {
    expect(isSpaceMouseDevice(spaceMouse)).toBe(true);
    expect(isSpaceMouseDevice({ vendorId: 0x046d, collections: [{ usagePage: 1, usage: 8 }] })).toBe(true);
    expect(isSpaceMouseDevice({ vendorId: 0x256f })).toBe(true);
    expect(isSpaceMouseDevice(logitechMouse)).toBe(false);
    expect(isSpaceMouseDevice(keyboard)).toBe(false);
  });

  it('grants HID to the app origin for a 3D mouse and nothing else', () => {
    expect(hidDevicePermitted({ deviceType: 'hid', origin: `${ORIGIN}/`, device: spaceMouse }, ORIGIN)).toBe(true);
    expect(hidDevicePermitted({ deviceType: 'hid', origin: 'https://evil.example/', device: spaceMouse }, ORIGIN)).toBe(false);
    expect(hidDevicePermitted({ deviceType: 'hid', origin: `${ORIGIN}/`, device: keyboard }, ORIGIN)).toBe(false);
    expect(hidDevicePermitted({ deviceType: 'usb', origin: `${ORIGIN}/`, device: spaceMouse }, ORIGIN)).toBe(false);
  });

  it('picks the first 3D mouse in the picker list, or cancels', () => {
    expect(pickSpaceMouse([keyboard, logitechMouse, spaceMouse])).toBe('a');
    expect(pickSpaceMouse([keyboard, logitechMouse])).toBe('');
  });

  it('allows the hid permission check for the app origin only', () => {
    expect(permissionAllowed('hid', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(permissionAllowed('hid', 'https://evil.example/', ORIGIN)).toBe(false);
  });
});

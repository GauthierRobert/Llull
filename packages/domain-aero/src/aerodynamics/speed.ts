/** Speed parameter shared by the aerodynamics commands: a value plus its unit, converted to m/s. */

import { z } from '@core/commands/schema';

export const SPEED_UNITS = { 'm/s': 1, 'km/h': 1 / 3.6, kn: 1852 / 3600, mph: 0.44704 } as const;

export type SpeedUnit = keyof typeof SPEED_UNITS;

export const speedParam = {
  speed: z.number().optional().describe('Speed (air speed for aircraft, ground speed for cycling) in speedUnit, >= 0.'),
  speedUnit: z.enum(['m/s', 'km/h', 'kn', 'mph']).optional().describe('Unit of speed: m/s (default), km/h, kn (knot, 1852 m/h) or mph.'),
};

export const toMetresPerSecond = (value: number, unit: SpeedUnit): number => value * SPEED_UNITS[unit];

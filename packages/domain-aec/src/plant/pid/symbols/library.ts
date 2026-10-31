/** The built-in symbol library as data (plant 04 PID TR-PID-07): one symbol per class llull maps, per convention. */

import { PID_ACTUATORS, PID_CONVENTIONS, PID_INSTRUMENT_DISPLAYS, PID_INSTRUMENT_LOCATIONS, type PidConvention } from '../model';
import { KNOWN_EQUIPMENT_CLASSES, KNOWN_PIPING_CLASSES } from '../dexpi/proteusClasses';
import { equipmentSymbol } from './equipment';
import { actuatorSymbol, connectorSymbol, flowArrowSymbol, instrumentSymbol, pipingSymbol } from './piping';
import type { PidSymbol } from './shapes';

export interface SymbolEntry {
  readonly convention: PidConvention;
  readonly symbol: PidSymbol;
}

/** Every symbol of a convention, in a fixed order (equipment, components, connectors, instruments, actuators, arrow). */
export function symbolsOf(convention: PidConvention): PidSymbol[] {
  return [
    ...[...KNOWN_EQUIPMENT_CLASSES].map((cls) => equipmentSymbol(cls, convention)),
    ...[...KNOWN_PIPING_CLASSES].map((cls) => pipingSymbol(cls)),
    connectorSymbol('in'),
    connectorSymbol('out'),
    ...PID_INSTRUMENT_LOCATIONS.flatMap((location) => PID_INSTRUMENT_DISPLAYS.map((display) => instrumentSymbol(location, display))),
    ...PID_ACTUATORS.map((kind) => actuatorSymbol(kind)),
    flowArrowSymbol,
  ];
}

export const allSymbols = (): SymbolEntry[] =>
  PID_CONVENTIONS.flatMap((convention) => symbolsOf(convention).map((symbol) => ({ convention, symbol })));

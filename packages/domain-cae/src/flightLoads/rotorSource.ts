/** Rotor records and operating speeds of the flight model for check_rotor_resonance, read through the registry (inspect_dynamics, trim_flight; L10: no import of the dynamics plugin). */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';

export interface RotorRecord {
  readonly id: string;
  /** Commanded constant speed of the rotor record (add_rotor), rpm. */
  readonly rpm: number;
  /** minRpm..maxRpm of the controller that commands this rotor, when there is one. */
  readonly controllerBand: { readonly controllerId: string; readonly lowRpm: number; readonly highRpm: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The rotors of the flight slice with the speed band of their controller (the one of `scenario` when given, else the first listing the rotor).
 * @failure inspect_dynamics unregistered or no flight slice -> text; unknown scenario -> text
 */
export function rotorsOfFlightModel(
  doc: CadDocument,
  scenario: string | undefined,
  ctx: ExecutionContext | undefined,
): RotorRecord[] | string {
  const inspect = ctx?.registry('inspect_dynamics');
  if (inspect === undefined) return 'inspect_dynamics is not registered (the dynamics plugin is not installed)';
  const result = inspect.run(doc, { mobility: false }, ctx);
  const flight = isRecord(result.data) ? result.data['flight'] : undefined;
  if (!isRecord(flight) || !isRecord(flight['rotors']) || Object.keys(flight['rotors']).length === 0)
    return 'the document has no flight rotors (add_rotor)';
  const controllers = isRecord(flight['controllers']) ? Object.values(flight['controllers']).filter(isRecord) : [];
  let wanted: unknown = null;
  if (scenario !== undefined) {
    const scenarios = isRecord(flight['scenarios']) ? flight['scenarios'] : {};
    const found = Object.hasOwn(scenarios, scenario) ? scenarios[scenario] : undefined;
    if (!isRecord(found)) return `no flight scenario '${scenario}'`;
    wanted = found['controllerId'];
  }
  return Object.values(flight['rotors'])
    .filter(isRecord)
    .map((rotor): RotorRecord => {
      const id = String(rotor['id']);
      const controller = controllers.find(
        (candidate) =>
          (wanted === null || candidate['id'] === wanted) && Array.isArray(candidate['rotorIds']) && candidate['rotorIds'].includes(id),
      );
      const low = controller?.['minRpm'];
      const high = controller?.['maxRpm'];
      return {
        id,
        rpm: finite(rotor['rpm']) ? Math.abs(rotor['rpm']) : 0,
        controllerBand:
          controller !== undefined && finite(low) && finite(high) && high > 0 && low <= high
            ? { controllerId: String(controller['id']), lowRpm: low, highRpm: high }
            : null,
      };
    });
}

/**
 * Trimmed rotor speeds (trim_flight at the given airspeed and flight path): rotor id -> rpm.
 * @failure trim_flight unregistered or refused -> text (the refusal summary)
 */
export function trimmedRpm(
  doc: CadDocument,
  condition: { scenario: string; airspeedMps?: number | undefined; flightPathDeg?: number | undefined },
  ctx: ExecutionContext | undefined,
): Record<string, number> | string {
  const trim = ctx?.registry('trim_flight');
  if (trim === undefined) return 'trim_flight is not registered (the dynamics plugin is not installed)';
  const params = {
    scenario: condition.scenario,
    ...(condition.airspeedMps === undefined ? {} : { airspeedMps: condition.airspeedMps }),
    ...(condition.flightPathDeg === undefined ? {} : { flightPathDeg: condition.flightPathDeg }),
  };
  const result: CommandResult = trim.run(doc, params, ctx);
  const controls = isRecord(result.data) && Array.isArray(result.data['controls']) ? result.data['controls'] : null;
  if (result.rejected === true || controls === null) return result.summary;
  const speeds: Record<string, number> = {};
  for (const control of controls)
    if (isRecord(control) && control['kind'] === 'rotor_rpm' && control['unit'] === 'rpm' && finite(control['value']))
      speeds[String(control['id'])] = control['value'];
  return speeds;
}

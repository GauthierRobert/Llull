/** Installs the engine laws into the generic dynamics injection points (TECHNICAL_SPEC 11 Q3); called once by the dynamics catalog. */

import { setEngineLossLaw } from '../../sim/engineLossHook';
import { withEngineLosses } from '../../sim/engine/engineLosses';
import { realismData } from '../../sim/engine/engineRealism';
import { setRealismLaw } from '../realismHook';

export function installEngineLaws(): void {
  setEngineLossLaw(withEngineLosses);
  setRealismLaw(realismData);
}

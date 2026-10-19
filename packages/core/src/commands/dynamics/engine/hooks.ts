/** Installs the engine laws into the generic dynamics injection points (TECHNICAL_SPEC 11 Q3); called once by the dynamics catalog. */

import { setEngineLossLaw } from '../../../dynamics/engineLossHook';
import { withEngineLosses } from '../../../dynamics/engine/engineLosses';
import { realismData } from '../../../dynamics/engine/engineRealism';
import { setRealismLaw } from '../realismHook';

export function installEngineLaws(): void {
  setEngineLossLaw(withEngineLosses);
  setRealismLaw(realismData);
}

/**
 * Engine injection points (TECHNICAL_SPEC 11 Q3). The suite swaps the module-level engine laws, so it runs isolated (tests/isolatedSuites.ts):
 * the shared module graph of the other suites never sees a missing law.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulationModel } from '@core/dynamics/simulationModel';
import { setEngineLossLaw } from '@core/dynamics/engineLossHook';
import { NO_REALISM_LAW, realismOf, setRealismLaw } from '@core/commands/dynamics/realismHook';
import { installEngineLaws } from '@core/commands/dynamics/engine/hooks';
import { calibratedEngine } from './engineRealismFixture';
import { sliderCrank } from './sliderCrankFixture';

afterEach(() => installEngineLaws());

describe('engine injection points (spec 11 Q3)', () => {
  it('a model with losses is refused when no engine friction law is installed, never run lossless', () => {
    const { doc } = calibratedEngine();
    setEngineLossLaw(null);
    const built = buildSimulationModel(doc, 1e-4);
    expect('error' in built && built.error).toMatch(/no engine friction law is installed/);
    installEngineLaws();
    expect('error' in buildSimulationModel(doc, 1e-4)).toBe(false);
  });

  it('without a realism law a model with losses gets a warning-only block, a model without losses none', () => {
    setRealismLaw(null);
    const withLosses = calibratedEngine().doc.dynamics;
    const input = (dynamics: unknown): Parameters<typeof realismOf>[0] => ({ dynamics }) as unknown as Parameters<typeof realismOf>[0];
    expect(realismOf(input(withLosses))).toEqual({ losses: null, warnings: [NO_REALISM_LAW] });
    expect(realismOf(input(sliderCrank().doc.dynamics))).toBeNull();
  });
});

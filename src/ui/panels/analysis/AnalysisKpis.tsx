// Top of the Analysis panel: the verdict chip (set-up incomplete / ready to solve / solved) and the headline numbers of the solved results.
// A tile with a location highlights it on the model.

import React from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { lengthUnitName, stressUnitName } from '@cae/decks/units';
import { KpiStrip, StatusChip, type Kpi, type StatusTone } from '@ui/panels/PanelParts';
import type { CheckView } from './analysisData';
import { completeThermal, type SetupItem, type SetupItems } from './analysisItems';
import { formatQuantities, formatSignificant } from './quantityFormat';
import { useFocusSetupItem } from './useFocusSetupItem';

function verdict(state: string, check: CheckView | null): { tone: StatusTone; text: string } {
  if (state === 'solved') return { tone: 'ok', text: 'Solved' };
  if (check?.status === 'fail') return { tone: 'bad', text: 'Set-up incomplete' };
  if (check?.status === 'warn') return { tone: 'warn', text: 'Ready to solve (warnings)' };
  return { tone: 'info', text: check === null ? state : 'Ready to solve' };
}

/** The first blocking check in plain words, so "set-up incomplete" always says what to do next. */
function NextStep({ check }: { check: CheckView | null }): React.ReactElement | null {
  const first = check?.items.find((item) => item.severity === 'error') ?? check?.items[0];
  if (first === undefined) return null;
  return (
    <p className="analysis__next" data-testid="analysis-next-step">
      <strong>{first.severity === 'error' ? 'To fix:' : 'Check:'}</strong> {first.message}
      {check !== null && check.items.length > 1 ? ` (+${check.items.length - 1} more in Checks)` : ''}
    </p>
  );
}

const residualTone = (relative: number): StatusTone => (relative < 0.01 ? 'ok' : relative < 0.05 ? 'warn' : 'bad');

function resultKpis(analysisCase: AnalysisCase, items: SetupItems, focus: (item: SetupItem) => void): Kpi[] {
  const { results } = analysisCase;
  if (results === undefined) return [];
  const pin = (id: string): SetupItem | undefined => items.extremes.find((item) => item.id === id);
  const at = (id: string): { onClick?: () => void } => {
    const item = pin(id);
    return item === undefined ? {} : { onClick: () => focus(item) };
  };
  const kpis: Kpi[] = [];
  const loadCases = Array.isArray(results.loadCases) ? results.loadCases : [];
  const peak = [...loadCases].sort((a, b) => b.maxVonMises.value - a.maxVonMises.value)[0];
  if (peak !== undefined) {
    const stress = formatQuantities([peak.maxVonMises.value], stressUnitName(analysisCase.unitSystem));
    kpis.push({
      key: 'von-mises',
      label: 'Max von Mises',
      value: `${stress.texts[0]} ${stress.unit}`,
      sub: peak.name,
      ...at(`vm:${peak.name}`),
    });
  }
  const deepest = [...loadCases].sort((a, b) => b.maxDisplacement.value - a.maxDisplacement.value)[0];
  if (deepest !== undefined)
    kpis.push({
      key: 'displacement',
      label: 'Max displacement',
      value: `${formatSignificant(deepest.maxDisplacement.value)} ${lengthUnitName(analysisCase.unitSystem)}`,
      sub: deepest.name,
      ...at(`u:${deepest.name}`),
    });
  const thermal = completeThermal(results.thermal);
  if (thermal !== undefined) {
    const unit = thermal.temperatureScale === 'K' ? 'K' : '°C';
    kpis.push(
      { key: 'tmax', label: 'Hottest', value: `${formatSignificant(thermal.maxT.value)} ${unit}`, tone: 'bad', ...at('tmax') },
      { key: 'tmin', label: 'Coldest', value: `${formatSignificant(thermal.minT.value)} ${unit}`, ...at('tmin') },
      {
        key: 'heat-balance',
        label: 'Heat balance',
        value: `${formatSignificant(thermal.heatBalance.residualRel * 100, 2)} %`,
        sub: 'residual',
        tone: residualTone(Math.abs(thermal.heatBalance.residualRel)),
      },
    );
  }
  const first = results.frequenciesHz?.[0] ?? results.bucklingFactors?.[0];
  if (first !== undefined)
    kpis.push({
      key: 'first-mode',
      label: results.frequenciesHz === undefined ? 'First buckling factor' : 'First frequency',
      value: `${formatSignificant(first, 5)}${results.frequenciesHz === undefined ? ' ×' : ' Hz'}`,
    });
  return kpis;
}

interface AnalysisKpisProps {
  analysisCase: AnalysisCase;
  state: string;
  check: CheckView | null;
  items: SetupItems;
}

export function AnalysisKpis({ analysisCase, state, check, items }: AnalysisKpisProps): React.ReactElement {
  const focus = useFocusSetupItem();
  const { tone, text } = verdict(state, check);
  return (
    <div className="analysis__headline" data-testid="analysis-headline">
      <StatusChip tone={tone} text={text} testId="analysis-state-chip" />
      {state !== 'solved' && <NextStep check={check} />}
      <KpiStrip label="Key results" items={resultKpis(analysisCase, items, focus)} />
    </div>
  );
}

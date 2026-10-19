// Airfoil section: lift, moment and the pressure distribution of a closed 2D polyline airfoil (selected in the model) or of a NACA code.
// The outline is coloured by Cp on the model; every angle of attack row highlights the section with its lift beacon.

import React from 'react';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { getCommand } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useIsFocused } from '@ui/store/focusStore';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { FormError, KpiStrip, ListRow, PanelSection, type Kpi } from '@ui/panels/PanelParts';
import { AERO_COLORS, cpColor } from '@ui/viewport/3d/aero/aeroGeometry';
import { formatQuantity, type AirfoilView } from './aeroData';
import { quarterChordWorld, selectedPolyline } from './airfoilOverlayView';
import { AIRFOIL_ALPHAS, type AirfoilAnalysis } from './useAeroAnalysis';

interface AeroAirfoilSectionProps {
  entityId: string | null;
  naca: string;
  onNaca: (code: string) => void;
  alphaDeg: number;
  onAlpha: (alphaDeg: number) => void;
  analysis: AirfoilAnalysis;
  cpRange: { min: number; max: number } | null;
}

const css = ([r, g, b]: readonly [number, number, number]): string =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
const ALPHA_OPTIONS = AIRFOIL_ALPHAS.map((alpha) => [String(alpha), `${alpha}°`] as const);

function CpLegend({ range }: { range: { min: number; max: number } }): React.ReactElement {
  const stops = [-1, -0.5, 0, 0.5, 1].map((t) => css(cpColor(t < 0 ? t * -range.min : t * range.max, range.min, range.max)));
  return (
    <div className="aero__legend" aria-label="Pressure coefficient legend" data-testid="aero-legend">
      <div className="aero__legend-bar" style={{ background: `linear-gradient(90deg, ${stops.join(', ')})` }} />
      <div className="aero__legend-ends">
        <span>Suction Cp {formatQuantity(range.min)}</span>
        <span>Pressure Cp {formatQuantity(range.max)}</span>
      </div>
    </div>
  );
}

function PolarRows({
  view,
  entityId,
  alphaDeg,
  onAlpha,
}: {
  view: AirfoilView;
  entityId: string | null;
  alphaDeg: number;
  onAlpha: (a: number) => void;
}): React.ReactElement {
  const focusItem = useFocusItem();
  const entity = useStore((s) => (entityId === null ? undefined : s.document.entities[entityId]));
  const polyline = selectedPolyline(entity);
  return (
    <ul className="panel__list" aria-label="Angle of attack results">
      {view.polar.map((row) => (
        <PolarRow
          key={row.alphaDeg}
          alphaDeg={row.alphaDeg}
          cl={row.cl}
          cm={row.cm}
          current={row.alphaDeg === alphaDeg}
          onSelect={() => {
            onAlpha(row.alphaDeg);
            if (entityId !== null && polyline !== null)
              focusItem({
                key: `aero:polar:${row.alphaDeg}`,
                label: `${view.label} at ${row.alphaDeg}°`,
                color: AERO_COLORS.lift,
                entityIds: [entityId],
                markers: [{ position: quarterChordWorld(polyline), label: `Cl = ${row.cl.toFixed(2)} @ ${row.alphaDeg}°` }],
              });
          }}
        />
      ))}
    </ul>
  );
}

function PolarRow({
  alphaDeg,
  cl,
  cm,
  current,
  onSelect,
}: {
  alphaDeg: number;
  cl: number;
  cm: number;
  current: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const focused = useIsFocused(`aero:polar:${alphaDeg}`);
  return (
    <ListRow
      testId={`aero-polar-${alphaDeg}`}
      selected={focused || current}
      current={current}
      swatch={AERO_COLORS.lift}
      label={`Show angle of attack ${alphaDeg}°`}
      onSelect={onSelect}
    >
      <span className="panel__row-main">α {alphaDeg}°</span>
      <span className="panel__row-meta">
        Cl {cl.toFixed(3)} · Cm {cm.toFixed(3)}
      </span>
    </ListRow>
  );
}

export function AeroAirfoilSection({
  entityId,
  naca,
  onNaca,
  alphaDeg,
  onAlpha,
  analysis,
  cpRange,
}: AeroAirfoilSectionProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const focusItem = useFocusItem();
  const entity = useStore((s) => (entityId === null ? undefined : s.document.entities[entityId]));
  const polyline = selectedPolyline(entity);
  const { view } = analysis;
  const row = view?.polar.find((item) => item.alphaDeg === alphaDeg) ?? view?.polar[0];
  const kpis: Kpi[] =
    view === null || row === undefined
      ? []
      : [
          {
            key: 'cl',
            label: 'Lift Cl',
            value: row.cl.toFixed(3),
            sub: `at ${row.alphaDeg}°`,
            ...(polyline === null
              ? {}
              : {
                  onClick: () =>
                    focusItem({
                      key: 'aero:cl',
                      label: `Lift Cl = ${row.cl.toFixed(2)}`,
                      color: AERO_COLORS.lift,
                      entityIds: entityId === null ? [] : [entityId],
                      markers: [{ position: quarterChordWorld(polyline), label: `Cl = ${row.cl.toFixed(2)} @ ${row.alphaDeg}°` }],
                    }),
                }),
          },
          { key: 'cm', label: 'Moment Cm', value: row.cm.toFixed(3), sub: 'about the quarter chord' },
          ...(view.liftSlopePerDeg === null ? [] : [{ key: 'slope', label: 'Lift slope', value: `${view.liftSlopePerDeg.toFixed(3)} /°` }]),
        ];
  return (
    <PanelSection
      title="Airfoil"
      hint="Select a closed airfoil outline in the model, or type a NACA code (e.g. 2412)."
      testId="aero-airfoil"
    >
      <div className="aero__inputs">
        {entityId === null ? (
          <div className="aero__pair">
            <LabeledInput label="NACA" type="text" value={naca} placeholder="2412" testId="aero-naca" onChange={onNaca} />
            {getCommand('draw_naca_airfoil') !== undefined && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={view === null}
                onClick={() => dispatch('draw_naca_airfoil', { naca: naca.trim(), chord: 1 }, { selectAffected: true })}
                title="Draw this section (chord 1 document unit) so it can be shown on the model"
              >
                Draw it
              </button>
            )}
          </div>
        ) : (
          <p className="aero__note">Analysing the selected outline {view?.label ?? ''}.</p>
        )}
        <LabeledSelect
          label="Angle"
          value={String(alphaDeg)}
          options={ALPHA_OPTIONS}
          testId="aero-alpha"
          onChange={(value) => onAlpha(Number(value))}
        />
      </div>
      <FormError text={analysis.problem} />
      <KpiStrip items={kpis} label="Airfoil headline numbers" />
      {view !== null && <PolarRows view={view} entityId={entityId} alphaDeg={alphaDeg} onAlpha={onAlpha} />}
      {cpRange !== null && <CpLegend range={cpRange} />}
    </PanelSection>
  );
}

// Aerodynamics browser: drag of the selected solids (frontal area, CdA, force, power, q, Re) and lift / pressure of an airfoil section.
// Read-only: every number comes from frontal_area / compute_aero_drag / standard_atmosphere / analyze_airfoil / analyze_wing run locally; what
// is shown here is drawn on the model by AeroOverlay (wind arrows, drag arrow, Cp-coloured airfoil) and rows highlight their place.

import React, { useEffect, useMemo, useState } from 'react';
import '@ui/styles/panels/aero.css';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { useAeroViewStore, type AeroAirfoilView, type AeroBodyView } from '@ui/store/aeroViewStore';
import { PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { FormError } from '@ui/panels/PanelParts';
import { normalized } from '@ui/viewport/3d/aero/aeroGeometry';
import { formatQuantity } from './aeroData';
import { AeroAirfoilSection } from './AeroAirfoilSection';
import { AeroBodyInputs } from './AeroBodyInputs';
import { AeroBodyKpis, AeroBodyRows } from './AeroBodyResults';
import { AeroWingSection } from './AeroWingSection';
import { airfoilOverlayView, selectedPolyline } from './airfoilOverlayView';
import { useAirfoilAnalysis, useBodyAnalysis, useSelectedAirfoilId, solidIds, type AeroInputs } from './useAeroAnalysis';

const DEFAULT_INPUTS: AeroInputs = {
  allSolids: false,
  preset: '+x',
  custom: ['1', '0', '0'],
  speed: '100',
  speedUnit: 'km/h',
  altitude: '0',
  dragMode: 'cd',
  cd: '0.3',
  cdA: '0.5',
};

export function AeroPanel({ className }: { className?: string }): React.ReactElement {
  const [inputs, setInputs] = useState<AeroInputs>(DEFAULT_INPUTS);
  const [naca, setNaca] = useState('');
  const [alphaDeg, setAlphaDeg] = useState(4);
  const shown = useAeroViewStore((s) => s.shown);
  const setShown = useAeroViewStore((s) => s.setShown);
  const publish = useAeroViewStore((s) => s.publish);
  const body = useBodyAnalysis(inputs);
  const airfoilId = useSelectedAirfoilId();
  const airfoil = useAirfoilAnalysis({ entityId: airfoilId, naca });
  const airfoilEntity = useStore((s) => (airfoilId === null ? undefined : s.document.entities[airfoilId]));
  const solidCount = useStore((s) => solidIds(s.document).length);

  const bodyView = useMemo((): AeroBodyView | null => {
    if (body.bounds === null || body.flow === null || body.frontal === null) return null;
    return {
      flow: normalized(body.flow),
      bounds: body.bounds,
      frontalAreaM2: body.frontal.areaM2,
      dragN: body.drag?.dragN ?? null,
      dynamicPressurePa: body.drag?.dynamicPressurePa ?? null,
    };
  }, [body]);
  const airfoilView = useMemo((): AeroAirfoilView | null => {
    const polyline = selectedPolyline(airfoilEntity);
    if (airfoilId === null || polyline === null || airfoil.view === null) return null;
    return airfoilOverlayView(airfoilId, polyline, airfoil.view, alphaDeg);
  }, [airfoilId, airfoilEntity, airfoil.view, alphaDeg]);

  useEffect(() => {
    publish(bodyView, airfoilView);
  }, [publish, bodyView, airfoilView]);
  useEffect(() => () => useAeroViewStore.getState().publish(null, null), []);

  const cpRange = airfoilView === null ? null : { min: airfoilView.cpMin, max: airfoilView.cpMax };
  const noBody = body.bodyIds.length === 0 && inputs.dragMode === 'cd';
  return (
    <aside className={classNames('panel', className)} aria-label="Aerodynamics" data-testid="aero-panel">
      <PanelHeader title="Aerodynamics" />
      <label className="loads-check aero__toggle">
        <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} data-testid="aero-shown" />
        Show on model (wind, drag, pressure)
      </label>
      <AeroBodyKpis analysis={body} />
      <PanelSection
        title="Body"
        hint={
          inputs.allSolids
            ? `All ${solidCount} solids in the document.`
            : `${body.bodyIds.length} selected solid${body.bodyIds.length === 1 ? '' : 's'}. Select solids in the model or the Objects list.`
        }
        testId="aero-body"
      >
        <AeroBodyInputs inputs={inputs} onChange={setInputs} solidCount={solidCount} />
        {body.atmosphere !== null && (
          <p className="aero__note" data-testid="aero-air">
            Air at {formatQuantity(Number(inputs.altitude) || 0)} m: ρ {formatQuantity(body.atmosphere.densityKgM3)} kg/m³ · μ{' '}
            {formatQuantity(body.atmosphere.viscosityPaS)} Pa·s · {formatQuantity(body.atmosphere.temperatureK - 273.15)} °C
          </p>
        )}
        {noBody ? (
          <PanelEmpty compact icon="cube" message="No solid selected" hint="Select the body whose drag you want, or tick All solids." />
        ) : (
          <FormError text={body.problem} />
        )}
        <AeroBodyRows analysis={body} />
      </PanelSection>
      <AeroAirfoilSection
        entityId={airfoilId}
        naca={naca}
        onNaca={setNaca}
        alphaDeg={alphaDeg}
        onAlpha={setAlphaDeg}
        analysis={airfoil}
        cpRange={cpRange}
      />
      <AeroWingSection alphaDeg={alphaDeg} />
    </aside>
  );
}

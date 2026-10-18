// Bill of materials (08 §7): the read-only `bill_of_materials` query with its standardParts and materials sections.

import React from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { parseBom } from './fastenerView';
import { bomPartFocus } from './fastenerFocus';
import { useStore } from '@ui/store';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { entitiesFocus } from '@ui/panels/entityFocus';

export function BomSections(): React.ReactElement {
  const bom = useReadOnlyQuery('bill_of_materials', parseBom);
  const focusItem = useFocusItem();
  const view = bom.view;
  return (
    <PanelSection title="Bill of materials" testId="fastener-bom">
      <div className="mfg__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => bom.run({ includeStandardParts: true, includeMaterials: true })}
          data-testid="bom-run"
        >
          {view === null ? 'Generate BOM' : 'Refresh BOM'}
        </button>
      </div>
      {view !== null && (
        <>
          {bom.stale && (
            <p className="review-panel__stale" role="status">
              <span aria-hidden="true">◌</span> The model changed. Refresh to update.
            </p>
          )}
          <p className="panel__row-meta" data-testid="bom-total-mass">
            Total mass {view.totalMassKg} kg
            {view.rowsWithoutDensity.length > 0 && ` · no density for ${view.rowsWithoutDensity.join(', ')} (excluded)`}
          </p>
          <h4 className="mfg__subhead">Standard parts</h4>
          {view.standardParts.length === 0 ? (
            <p className="panel__row-meta" data-testid="bom-no-standard">
              No standard parts.
            </p>
          ) : (
            <table className="mfg__table" data-testid="bom-standard">
              <thead>
                <tr>
                  <th scope="col">Part number</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Mass</th>
                </tr>
              </thead>
              <tbody>
                {view.standardParts.map((row) => (
                  <tr key={row.partNumber}>
                    <th scope="row">
                      <button
                        type="button"
                        className="takeoff-item"
                        title="Show every placed one on the model"
                        data-testid={`bom-show-${row.partNumber}`}
                        onClick={() => focusItem(bomPartFocus(useStore.getState().document, row.partNumber))}
                      >
                        {row.partNumber}
                      </button>
                    </th>
                    <td>{row.count}</td>
                    <td>
                      {row.mass === '' ? '—' : row.mass}
                      {row.representative && <span className="finding__badge">placeholder geometry</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4 className="mfg__subhead">Materials</h4>
          {view.materials.length === 0 ? (
            <p className="panel__row-meta" data-testid="bom-no-materials">
              No assigned materials.
            </p>
          ) : (
            <table className="mfg__table" data-testid="bom-materials">
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col">Solids</th>
                  <th scope="col">Mass kg</th>
                </tr>
              </thead>
              <tbody>
                {view.materials.map((row) => (
                  <tr key={row.materialId}>
                    <th scope="row">
                      <button
                        type="button"
                        className="takeoff-item"
                        title="Show the solids of this material on the model"
                        data-testid={`bom-material-show-${row.materialId}`}
                        onClick={() => {
                          const doc = useStore.getState().document;
                          const ids = doc.order.filter((id) => doc.entities[id]?.materialId === row.materialId);
                          focusItem(
                            entitiesFocus(doc, {
                              key: `fasteners:bom-material:${row.materialId}`,
                              label: `${row.materialId} · ${row.massKg} kg`,
                              color: doc.materials[row.materialId]?.color,
                              ids,
                            }),
                          );
                        }}
                      >
                        {row.materialId}
                      </button>
                    </th>
                    <td>{row.solidCount}</td>
                    <td>
                      {row.massKg}
                      {row.unverified && <span className="finding__badge">unverified</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view.unassignedSolidCount > 0 && <p className="panel__row-meta">{view.unassignedSolidCount} solid(s) without a material.</p>}
        </>
      )}
    </PanelSection>
  );
}

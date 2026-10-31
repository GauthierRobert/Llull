// Toolbar control of the deformation review overlays: the master switch and, when on, the layers and the reference shape to compare with (UI-only state).

import React, { useId } from 'react';
import { Icon } from '@ui/components/Icon';
import { DEFORM_LAYERS, useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { REFERENCE_KINDS, referenceFieldProblem, referenceFields, referenceParams } from './deformOverlayGeometry';

const DEFORM_OPTIONS_ID = 'deform-overlay-options';

function ReferenceFields(): React.ReactElement {
  const draft = useDeformOverlayStore((s) => s.reference);
  const setReference = useDeformOverlayStore((s) => s.setReference);
  const baseId = useId();
  const kind = draft?.kind ?? '';
  const complete = referenceParams(draft) !== null;
  return (
    <div className="vp-deform-reference">
      <label htmlFor={`${baseId}-kind`} className="vp-field-label">
        Reference shape
      </label>
      <select
        id={`${baseId}-kind`}
        className="vp-select"
        value={kind}
        onChange={(e) => setReference(e.target.value === '' ? null : { kind: e.target.value, fields: {} })}
      >
        <option value="">None</option>
        {REFERENCE_KINDS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      {draft !== null &&
        referenceFields(draft.kind).map(({ name, hint }) => {
          const problem = referenceFieldProblem(draft.kind, name, draft.fields);
          const problemId = `${baseId}-${name}-problem`;
          return (
            <label key={name} className="vp-field-label vp-deform-reference__field">
              {name}
              <input
                className="vp-input"
                type="text"
                value={draft.fields[name] ?? ''}
                placeholder={hint}
                aria-label={`Reference ${name}`}
                aria-invalid={problem !== null}
                aria-describedby={problem === null ? undefined : problemId}
                onChange={(e) => setReference({ kind: draft.kind, fields: { ...draft.fields, [name]: e.target.value } })}
              />
              {problem !== null && (
                <span id={problemId} className="vp-deform-reference__note">
                  {problem}
                </span>
              )}
            </label>
          );
        })}
      {draft !== null && !complete && (
        <span className="vp-deform-reference__note" role="status">
          Fill every field to draw the shape.
        </span>
      )}
    </div>
  );
}

/** The scale of the Jacobian map and, per drawn body, its range and folded vertices (or why there is no map). */
function JacobianLegend(): React.ReactElement {
  const stats = useDeformOverlayStore((s) => s.jacobian);
  const scope = useDeformOverlayStore((s) => s.jacobianScope);
  const setScope = useDeformOverlayStore((s) => s.setJacobianScope);
  return (
    <div className="vp-deform-jacobian" role="status" aria-label="Jacobian map">
      <div className="vp-deform-reference__note">
        det J: blue 0.5, grey 1, red 2 (volume kept at 1); magenta = folded (at or below the floor)
      </div>
      <label
        className="vp-field-label"
        title="Multiply the determinants of every deformation of a chain (the volume ratio against the original body), or read the last one alone"
      >
        <input type="checkbox" checked={scope === 'outermost'} onChange={(e) => setScope(e.target.checked ? 'outermost' : 'composed')} />
        Outermost only
      </label>
      {Object.entries(stats).map(([id, entry]) => (
        <div key={id} className="vp-deform-reference__note">
          {id}:{' '}
          {'failure' in entry
            ? entry.failure
            : `${entry.deforms > 1 ? `composed (${entry.deforms} deforms)` : `outermost deform (${entry.law})`}: det J ${entry.min?.toPrecision(3) ?? '-'} .. ${entry.max?.toPrecision(3) ?? '-'}, ${entry.folded} folded (det J <= ${entry.floor})`}
        </div>
      ))}
    </div>
  );
}

export function DeformOverlayControl(): React.ReactElement {
  const enabled = useDeformOverlayStore((s) => s.enabled);
  const setEnabled = useDeformOverlayStore((s) => s.setEnabled);
  return (
    <div className="vp-group" role="group" aria-label="Deform overlay">
      <button
        type="button"
        className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={enabled}
        aria-label="Deformation overlays"
        aria-expanded={enabled}
        aria-controls={DEFORM_OPTIONS_ID}
        title={
          enabled
            ? 'Hide the frame, region, lattice, curves and reference shape of the selected deformed bodies'
            : 'Show the frame, region, lattice, curves and reference shape of the selected deformed bodies (the first 4)'
        }
        onClick={() => setEnabled(!enabled)}
      >
        <Icon name="transformMove" size={14} />
        <span className="vp-btn__text">Deform</span>
      </button>
    </div>
  );
}

/** The layers and the reference shape, under the toolbar while the master switch is on. */
export function DeformOverlayPopover(): React.ReactElement | null {
  const enabled = useDeformOverlayStore((s) => s.enabled);
  const layers = useDeformOverlayStore((s) => s.layers);
  const setLayer = useDeformOverlayStore((s) => s.setLayer);
  if (!enabled) return null;
  return (
    <div id={DEFORM_OPTIONS_ID} className="vp-popover vp-deform-options" role="group" aria-label="Deformation overlay layers">
      {DEFORM_LAYERS.map(({ value, label, title }) => (
        <label key={value} className="vp-field-label" title={title}>
          <input type="checkbox" checked={layers[value]} onChange={(e) => setLayer(value, e.target.checked)} />
          {label}
        </label>
      ))}
      {layers.reference && <ReferenceFields />}
      {layers.jacobian && <JacobianLegend />}
    </div>
  );
}

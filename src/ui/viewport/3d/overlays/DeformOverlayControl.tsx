// Toolbar control of the deformation review overlays: the master switch and, when on, the layers and the reference shape to compare with (UI-only state).

import React, { useId } from 'react';
import { Icon } from '@ui/components/Icon';
import { DEFORM_LAYERS, useDeformOverlayStore } from '@ui/store/deformOverlayStore';
import { REFERENCE_KINDS, referenceFields, referenceParams } from './deformOverlayGeometry';

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
        aria-label="Reference shape"
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
        referenceFields(draft.kind).map(({ name, hint }) => (
          <label key={name} className="vp-field-label vp-deform-reference__field">
            {name}
            <input
              className="vp-input"
              type="text"
              value={draft.fields[name] ?? ''}
              placeholder={hint}
              aria-label={`Reference ${name}`}
              onChange={(e) => setReference({ kind: draft.kind, fields: { ...draft.fields, [name]: e.target.value } })}
            />
          </label>
        ))}
      {draft !== null && !complete && <span className="vp-deform-reference__note">Fill every field to draw the shape.</span>}
    </div>
  );
}

export function DeformOverlayControl(): React.ReactElement {
  const enabled = useDeformOverlayStore((s) => s.enabled);
  const setEnabled = useDeformOverlayStore((s) => s.setEnabled);
  return (
    <>
      <div className="vp-group" role="group" aria-label="Deform overlay">
        <button
          type="button"
          className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
          aria-pressed={enabled}
          aria-label="Deformation overlays"
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
    </>
  );
}

/** The layers and the reference shape, under the toolbar while the master switch is on. */
export function DeformOverlayPopover(): React.ReactElement | null {
  const enabled = useDeformOverlayStore((s) => s.enabled);
  const layers = useDeformOverlayStore((s) => s.layers);
  const setLayer = useDeformOverlayStore((s) => s.setLayer);
  if (!enabled) return null;
  return (
    <div className="vp-popover vp-deform-options" role="group" aria-label="Deformation overlay layers">
      {DEFORM_LAYERS.map(({ value, label, title }) => (
        <label key={value} className="vp-field-label" title={title}>
          <input
            type="checkbox"
            checked={layers[value]}
            onChange={(e) => setLayer(value, e.target.checked)}
            aria-label={`${label} layer`}
          />
          {label}
        </label>
      ))}
      {layers.reference && <ReferenceFields />}
    </div>
  );
}

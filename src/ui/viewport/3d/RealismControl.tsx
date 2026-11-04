// Viewport toolbar: realism tier (Draft / Standard / High). UI-only, persisted per user.

import React, { useId } from 'react';
import { type RealismTier, sanitizeRealism, useRealismStore } from '@ui/store/realismStore';
import { useEdgeLines } from './useRenderQuality';

const OPTIONS: { value: RealismTier; label: string; title: string }[] = [
  { value: 'draft', label: 'Draft', title: 'Draft — no shadows, fastest' },
  { value: 'standard', label: 'Standard', title: 'Standard — shadows scaled to the scene size' },
  { value: 'high', label: 'High', title: 'High — soft 4096² shadows on every solid and plant batch, contact shadows, feature edges' },
];

export function RealismControl(): React.ReactElement {
  const realism = useRealismStore((s) => s.realism);
  const setRealism = useRealismStore((s) => s.setRealism);
  const setEdges = useRealismStore((s) => s.setEdges);
  const edgeLines = useEdgeLines();
  const baseId = useId();
  return (
    <div className="vp-group vp-quality" role="group" aria-label="Realism settings">
      <label htmlFor={`${baseId}-realism`} className="vp-field-label vp-quality__label">
        Realism
      </label>
      <select
        id={`${baseId}-realism`}
        className="vp-select vp-select--ghost"
        value={realism}
        onChange={(e) => setRealism(sanitizeRealism(e.target.value))}
        aria-label="Realism"
        title="Realism — Draft drops shadows, High renders the richest ones"
      >
        {OPTIONS.map(({ value, label, title }) => (
          <option key={value} value={value} title={title}>
            {label}
          </option>
        ))}
      </select>
      <label className="vp-field-label" title="Feature edges: creases, silhouettes and contact lines (High draws them by default)">
        <input type="checkbox" checked={edgeLines} onChange={(e) => setEdges(e.target.checked ? 'on' : 'off')} aria-label="Edges" /> Edges
      </label>
    </div>
  );
}

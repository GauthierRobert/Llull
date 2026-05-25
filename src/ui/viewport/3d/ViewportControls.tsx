/**
 * @layer ui/viewport/3d
 *
 * ViewportControls — a minimal overlay mounted OUTSIDE the Canvas.
 *
 * Houses two control groups:
 *   1. Display mode — segmented button: Shaded / Wireframe / X-Ray.
 *   2. Section plane — toggle + axis selector + offset slider + flip checkbox.
 *
 * All state lives in the viewport store (render-only, no document mutation).
 * Positioned absolute in the top-left of the viewport wrapper.
 *
 * Styling uses existing CSS variables from the design system (V3).
 * Accessible: real <button>/<input>/<label> elements; aria attributes on
 * toggles (R10).
 */

import React, { useCallback, useId } from 'react';
import { useViewportStore } from '@ui/store';
import type { DisplayMode, ClipAxis } from '@ui/store';

// ---------------------------------------------------------------------------
// Display mode segmented button
// ---------------------------------------------------------------------------

const DISPLAY_MODES: { value: DisplayMode; label: string; title: string }[] = [
  { value: 'shaded',    label: 'Shaded',    title: 'Shaded — standard PBR rendering' },
  { value: 'wireframe', label: 'Wire',      title: 'Wireframe — show mesh edges only' },
  { value: 'xray',      label: 'X-Ray',     title: 'X-Ray — transparent surfaces' },
];

function DisplayModeControl(): React.ReactElement {
  const displayMode    = useViewportStore((s) => s.displayMode);
  const setDisplayMode = useViewportStore((s) => s.setDisplayMode);

  return (
    <div className="vp-control-group" role="group" aria-label="Display mode">
      {DISPLAY_MODES.map(({ value, label, title }) => (
        <button
          key={value}
          type="button"
          className={`vp-mode-btn${displayMode === value ? ' vp-mode-btn--active' : ''}`}
          aria-pressed={displayMode === value}
          title={title}
          onClick={() => setDisplayMode(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section / clipping plane controls
// ---------------------------------------------------------------------------

const CLIP_AXES: { value: ClipAxis; label: string }[] = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
];

function ClipPlaneControl(): React.ReactElement {
  const clipPlane      = useViewportStore((s) => s.clipPlane);
  const toggleClip     = useViewportStore((s) => s.toggleClipPlane);
  const setClipPlane   = useViewportStore((s) => s.setClipPlane);
  const baseId         = useId();

  const handleAxisChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setClipPlane({ axis: e.target.value as ClipAxis });
    },
    [setClipPlane],
  );

  const handleOffsetChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setClipPlane({ offset: parseFloat(e.target.value) });
    },
    [setClipPlane],
  );

  const handleFlipChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setClipPlane({ flipped: e.target.checked });
    },
    [setClipPlane],
  );

  return (
    <div className="vp-control-group vp-clip-group" aria-label="Section plane">
      <button
        type="button"
        className={`vp-clip-toggle${clipPlane.enabled ? ' vp-clip-toggle--active' : ''}`}
        aria-pressed={clipPlane.enabled}
        title={clipPlane.enabled ? 'Disable section plane' : 'Enable section plane'}
        onClick={toggleClip}
      >
        <span className="vp-clip-icon" aria-hidden="true">✂</span>
        Section
      </button>

      {clipPlane.enabled && (
        <div className="vp-clip-options">
          {/* Axis selector */}
          <label htmlFor={`${baseId}-axis`} className="vp-clip-label">
            Axis
          </label>
          <select
            id={`${baseId}-axis`}
            className="vp-clip-select"
            value={clipPlane.axis}
            onChange={handleAxisChange}
            aria-label="Section plane axis"
          >
            {CLIP_AXES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          {/* Offset slider */}
          <label htmlFor={`${baseId}-offset`} className="vp-clip-label">
            Offset&nbsp;<span className="vp-clip-value">{clipPlane.offset.toFixed(1)}</span>
          </label>
          <input
            id={`${baseId}-offset`}
            type="range"
            className="vp-clip-slider"
            min={-50}
            max={50}
            step={0.5}
            value={clipPlane.offset}
            onChange={handleOffsetChange}
            aria-label="Section plane offset"
            aria-valuemin={-50}
            aria-valuemax={50}
            aria-valuenow={clipPlane.offset}
          />

          {/* Flip toggle */}
          <label className="vp-clip-label vp-clip-flip-label">
            <input
              type="checkbox"
              className="vp-clip-flip"
              checked={clipPlane.flipped}
              onChange={handleFlipChange}
              aria-label="Flip section plane direction"
            />
            Flip
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported overlay
// ---------------------------------------------------------------------------

export function ViewportControls(): React.ReactElement {
  return (
    <div className="vp-controls-overlay" aria-label="Viewport controls">
      <DisplayModeControl />
      <ClipPlaneControl />
    </div>
  );
}

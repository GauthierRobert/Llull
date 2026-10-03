/**
 * @layer ui/viewport/3d
 *
 * ViewportControls — floating glass toolbar (top-left) mounted OUTSIDE the Canvas.
 * Groups: display mode, section plane, 3D snap, render quality, animation transport.
 * Section options open as a popover under the toolbar. Render-only state (viewport store);
 * never mutates the document.
 */

import React, { useCallback, useId } from 'react';
import { useViewportStore, useStore } from '@ui/store';
import type { DisplayMode, ClipAxis, QualityOverride } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';

function Divider(): React.ReactElement {
  return <span className="vp-divider" aria-hidden="true" />;
}

function Snap3DToggle(): React.ReactElement {
  const snap3dEnabled = useViewportStore((s) => s.snap3dEnabled);
  const toggleSnap3d = useViewportStore((s) => s.toggleSnap3d);
  return (
    <div className="vp-group" role="group" aria-label="3D snap">
      <button
        type="button"
        className={`vp-btn${snap3dEnabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={snap3dEnabled}
        title={snap3dEnabled ? 'Disable 3D snap (vertex/edge/face-center/grid)' : 'Enable 3D snap'}
        onClick={toggleSnap3d}
      >
        <Icon name="magnet" size={14} />
        <span className="vp-btn__text">Snap</span>
      </button>
    </div>
  );
}

const DISPLAY_MODES: { value: DisplayMode; label: string; title: string; icon: IconName }[] = [
  { value: 'shaded', label: 'Shaded', title: 'Shaded — standard PBR rendering', icon: 'shaded' },
  {
    value: 'wireframe',
    label: 'Wire',
    title: 'Wireframe — show mesh edges only',
    icon: 'wireframe',
  },
  { value: 'xray', label: 'X-Ray', title: 'X-Ray — transparent surfaces', icon: 'xray' },
];

function DisplayModeControl(): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);
  const setDisplayMode = useViewportStore((s) => s.setDisplayMode);

  return (
    <div className="vp-group vp-segmented" role="group" aria-label="Display mode">
      {DISPLAY_MODES.map(({ value, label, title, icon }) => (
        <button
          key={value}
          type="button"
          className={`vp-btn${displayMode === value ? ' vp-btn--selected' : ''}`}
          aria-pressed={displayMode === value}
          aria-label={label}
          title={title}
          onClick={() => setDisplayMode(value)}
        >
          <Icon name={icon} size={14} />
          <span className="vp-btn__text">{label}</span>
        </button>
      ))}
    </div>
  );
}

const CLIP_AXES: { value: ClipAxis; label: string }[] = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
];

function SectionToggle(): React.ReactElement {
  const enabled = useViewportStore((s) => s.clipPlane.enabled);
  const toggleClip = useViewportStore((s) => s.toggleClipPlane);
  return (
    <div className="vp-group" role="group" aria-label="Section plane">
      <button
        type="button"
        className={`vp-btn${enabled ? ' vp-btn--toggled' : ''}`}
        aria-pressed={enabled}
        aria-label="Section"
        title={enabled ? 'Disable section plane' : 'Enable section plane'}
        onClick={toggleClip}
      >
        <Icon name="section" size={14} />
        <span className="vp-btn__text">Section</span>
      </button>
    </div>
  );
}

function SectionPopover(): React.ReactElement | null {
  const clipPlane = useViewportStore((s) => s.clipPlane);
  const setClipPlane = useViewportStore((s) => s.setClipPlane);
  const baseId = useId();

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

  if (!clipPlane.enabled) return null;

  return (
    <div className="vp-popover vp-section-options">
      <label htmlFor={`${baseId}-axis`} className="vp-field-label">
        Axis
      </label>
      <select
        id={`${baseId}-axis`}
        className="vp-select"
        value={clipPlane.axis}
        onChange={handleAxisChange}
        aria-label="Section plane axis"
      >
        {CLIP_AXES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <label htmlFor={`${baseId}-offset`} className="vp-field-label">
        Offset
      </label>
      <div className="vp-slider-row">
        <input
          id={`${baseId}-offset`}
          type="range"
          className="vp-slider"
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
        <span className="vp-value">{clipPlane.offset.toFixed(1)}</span>
      </div>

      <label className="vp-field-label vp-flip">
        <input
          type="checkbox"
          checked={clipPlane.flipped}
          onChange={handleFlipChange}
          aria-label="Flip section plane direction"
        />
        Flip direction
      </label>
    </div>
  );
}

function AnimationTransportControls(): React.ReactElement | null {
  const animations = useStore((s) => s.document.animations);
  const animationPlaying = useViewportStore((s) => s.animationPlaying);
  const toggleAnimationPlaying = useViewportStore((s) => s.toggleAnimationPlaying);
  const resetAnimations = useViewportStore((s) => s.resetAnimations);

  if (Object.keys(animations).length === 0) return null;

  return (
    <>
      <Divider />
      <div className="vp-group" role="group" aria-label="Animation transport">
        <button
          type="button"
          className={`vp-btn vp-btn--icon${animationPlaying ? ' vp-btn--toggled' : ''}`}
          aria-label={animationPlaying ? 'Pause animations' : 'Play animations'}
          aria-pressed={animationPlaying}
          title={animationPlaying ? 'Pause animations' : 'Play animations'}
          onClick={toggleAnimationPlaying}
        >
          <Icon name={animationPlaying ? 'pause' : 'play'} size={14} />
        </button>
        <button
          type="button"
          className="vp-btn vp-btn--icon"
          aria-label="Reset animations"
          title="Reset animations to initial pose"
          onClick={resetAnimations}
        >
          <Icon name="reset" size={14} />
        </button>
      </div>
    </>
  );
}

const QUALITY_OPTIONS: { value: QualityOverride; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Auto — tier scales with scene size (recommended)' },
  {
    value: 'high',
    label: 'High',
    title: 'High — PCSS 16 samples, 2048² shadows (≤ 50 entities ideal)',
  },
  { value: 'medium', label: 'Medium', title: 'Medium — PCSS 8 samples, 1024² shadows' },
  {
    value: 'low',
    label: 'Low',
    title: 'Low — flat shadows, no contact shadows (best for 200+ entities)',
  },
];

function QualityControl(): React.ReactElement {
  const qualityOverride = useViewportStore((s) => s.qualityOverride);
  const setQualityOverride = useViewportStore((s) => s.setQualityOverride);
  const baseId = useId();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setQualityOverride(e.target.value as QualityOverride);
    },
    [setQualityOverride],
  );

  return (
    <div className="vp-group vp-quality" role="group" aria-label="Render quality settings">
      <label htmlFor={`${baseId}-quality`} className="vp-field-label vp-quality__label">
        Quality
      </label>
      <select
        id={`${baseId}-quality`}
        className="vp-select vp-select--ghost"
        value={qualityOverride}
        onChange={handleChange}
        aria-label="Render quality"
        title="Render quality — controls shadow cost; Auto scales with scene size"
      >
        {QUALITY_OPTIONS.map(({ value, label, title }) => (
          <option key={value} value={value} title={title}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ViewportControls(): React.ReactElement {
  return (
    <div className="vp-overlay vp-overlay--top-left" aria-label="Viewport controls">
      <div className="vp-toolbar">
        <DisplayModeControl />
        <Divider />
        <SectionToggle />
        <Snap3DToggle />
        <Divider />
        <QualityControl />
        <AnimationTransportControls />
      </div>
      <SectionPopover />
    </div>
  );
}

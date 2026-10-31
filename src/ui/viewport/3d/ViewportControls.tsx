// Floating 3D toolbar (outside the Canvas): display mode, section plane (popover), 3D snap, quality, animation transport.

import React, { useId } from 'react';
import { type DisplayMode, type ClipAxis, type QualityOverride, useViewportStore, useStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
import { DeformOverlayControl, DeformOverlayPopover } from './overlays/DeformOverlayControl';
import { ImplicitPreviewControl, ImplicitPreviewNote } from './implicitPreview/ImplicitPreviewControl';
import { WrapOverlayControl, WrapOverlayPopover } from './overlays/WrapOverlayControl';
import { NumberField } from '@ui/components/NumberField';
import { type SurfaceMapChoice, useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';

function Divider(): React.ReactElement {
  return <span className="vp-divider" aria-hidden="true" />;
}

function ToggleButton({ group, text, label, icon, pressed, title, onClick }: ToggleButtonProps): React.ReactElement {
  return (
    <div className="vp-group" role="group" aria-label={group}>
      <button
        type="button"
        className={`vp-btn${pressed ? ' vp-btn--toggled' : ''}`}
        aria-pressed={pressed}
        aria-label={label}
        title={title}
        onClick={onClick}
      >
        <Icon name={icon} size={14} />
        <span className="vp-btn__text">{text}</span>
      </button>
    </div>
  );
}

interface ToggleButtonProps {
  group: string;
  text: string;
  label?: string;
  icon: IconName;
  pressed: boolean;
  title: string;
  onClick: () => void;
}

function Snap3DToggle(): React.ReactElement {
  const enabled = useViewportStore((s) => s.snap3dEnabled);
  const toggle = useViewportStore((s) => s.toggleSnap3d);
  const title = enabled ? 'Disable 3D snap (vertex/edge/face-center/grid)' : 'Enable 3D snap';
  return <ToggleButton group="3D snap" text="Snap" icon="magnet" pressed={enabled} title={title} onClick={toggle} />;
}

const DISPLAY_MODES: { value: DisplayMode; label: string; title: string; icon: IconName }[] = [
  { value: 'shaded', label: 'Shaded', title: 'Shaded — standard PBR rendering', icon: 'shaded' },
  { value: 'wireframe', label: 'Wire', title: 'Wireframe — show mesh edges only', icon: 'wireframe' },
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
  const toggle = useViewportStore((s) => s.toggleClipPlane);
  const title = enabled ? 'Disable section plane' : 'Enable section plane';
  return (
    <ToggleButton group="Section plane" text="Section" label="Section" icon="section" pressed={enabled} title={title} onClick={toggle} />
  );
}

function SectionPopover(): React.ReactElement | null {
  const clipPlane = useViewportStore((s) => s.clipPlane);
  const setClipPlane = useViewportStore((s) => s.setClipPlane);
  const baseId = useId();

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
        onChange={(e) => setClipPlane({ axis: e.target.value as ClipAxis })}
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
          onChange={(e) => setClipPlane({ offset: parseFloat(e.target.value) })}
          aria-label="Section plane offset"
          aria-valuemin={-50}
          aria-valuemax={50}
          aria-valuenow={clipPlane.offset}
        />
        <NumberField
          className="vp-value vp-value--input"
          step={0.5}
          value={clipPlane.offset}
          onValueChange={(offset) => setClipPlane({ offset })}
          aria-label="Exact section distance"
          title="Exact offset in document units (the slider spans -50 to 50)"
        />
      </div>

      <label className="vp-field-label vp-flip">
        <input
          type="checkbox"
          checked={clipPlane.flipped}
          onChange={(e) => setClipPlane({ flipped: e.target.checked })}
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
  { value: 'high', label: 'High', title: 'High — PCSS 16 samples, 2048² shadows (≤ 50 entities ideal)' },
  { value: 'medium', label: 'Medium', title: 'Medium — PCSS 8 samples, 1024² shadows' },
  { value: 'low', label: 'Low', title: 'Low — flat shadows, no contact shadows (best for 200+ entities)' },
];

function QualityControl(): React.ReactElement {
  const qualityOverride = useViewportStore((s) => s.qualityOverride);
  const setQualityOverride = useViewportStore((s) => s.setQualityOverride);
  const baseId = useId();

  return (
    <div className="vp-group vp-quality" role="group" aria-label="Render quality settings">
      <label htmlFor={`${baseId}-quality`} className="vp-field-label vp-quality__label">
        Quality
      </label>
      <select
        id={`${baseId}-quality`}
        className="vp-select vp-select--ghost"
        value={qualityOverride}
        onChange={(e) => setQualityOverride(e.target.value as QualityOverride)}
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

const SURFACE_MAPS: { value: SurfaceMapChoice; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'Plain sheet colour' },
  { value: 'gaussian', label: 'Gaussian', title: 'Gaussian curvature K: blue negative, white flat, red positive' },
  { value: 'mean', label: 'Mean', title: 'Mean curvature H: blue negative, white flat, red positive' },
  {
    value: 'zebra',
    label: 'Zebra',
    title: 'Zebra stripes (isophotes of the normal against a light along +Z): kinks show where stripes break',
  },
  { value: 'draft', label: 'Draft', title: 'Draft against a pull along +Z: red undercut, amber below 3 degrees, green above' },
];

/** Analysis overlays on nurbs sheets and curves: a colour map and the curvature comb (UI-only). */
function SurfaceOverlayControl(): React.ReactElement {
  const map = useSurfaceOverlayStore((s) => s.map);
  const setMap = useSurfaceOverlayStore((s) => s.setMap);
  const comb = useSurfaceOverlayStore((s) => s.comb);
  const setComb = useSurfaceOverlayStore((s) => s.setComb);
  const frames = useSurfaceOverlayStore((s) => s.frames);
  const setFrames = useSurfaceOverlayStore((s) => s.setFrames);
  const baseId = useId();
  return (
    <>
      <div className="vp-group vp-quality" role="group" aria-label="Surface analysis overlay">
        <label htmlFor={`${baseId}-map`} className="vp-field-label vp-quality__label">
          Surface map
        </label>
        <select
          id={`${baseId}-map`}
          className="vp-select vp-select--ghost"
          value={map}
          onChange={(e) => setMap(e.target.value as SurfaceMapChoice)}
          aria-label="Surface map"
          title="Colour nurbs_surface sheets by curvature, zebra stripes or draft"
        >
          {SURFACE_MAPS.map(({ value, label, title }) => (
            <option key={value} value={value} title={title}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <ToggleButton
        group="Comb overlay"
        text="Comb"
        label="Curvature comb"
        icon="ruler"
        pressed={comb}
        title={comb ? 'Hide the curvature comb on nurbs curves' : 'Show the curvature comb on nurbs curves'}
        onClick={() => setComb(!comb)}
      />
      <ToggleButton
        group="Frames overlay"
        text="Frames"
        label="Sweep frames"
        icon="transformMove"
        pressed={frames}
        title={
          frames
            ? 'Hide the frames and section outlines of the selected sweeps and lofts'
            : 'Show the frames and section outlines of the selected sweeps and lofts (the first 8)'
        }
        onClick={() => setFrames(!frames)}
      />
    </>
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
        <Divider />
        <SurfaceOverlayControl />
        <DeformOverlayControl />
        <ImplicitPreviewControl />
        <WrapOverlayControl />
        <AnimationTransportControls />
      </div>
      <SectionPopover />
      <DeformOverlayPopover />
      <ImplicitPreviewNote />
      <WrapOverlayPopover />
    </div>
  );
}

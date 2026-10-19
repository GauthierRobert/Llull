// Viewport chip + popover for the 3D mouse (shown only where WebHID exists, i.e. the desktop app): connect, per-axis invert,
// pan / zoom / orbit speed and the dominant-axis option. Settings persist per viewer through the space mouse store.

import { useState } from 'react';
import { useSpaceMouseStore } from '@ui/store/spaceMouseStore';
import { AXIS_NAMES, type AxisName, SPEED_RANGE, type SpaceMouseSettings } from './spaceMouseMapping';
import { useSpaceMouse } from './useSpaceMouse';

const AXIS_LABELS: Record<AxisName, string> = {
  tx: 'Pan left / right',
  ty: 'Dolly in / out',
  tz: 'Pan up / down',
  rx: 'Tilt (orbit up / down)',
  ry: 'Roll (unused)',
  rz: 'Twist (orbit around)',
};

const SPEEDS: ReadonlyArray<{ key: 'panSpeed' | 'zoomSpeed' | 'orbitSpeed'; label: string }> = [
  { key: 'panSpeed', label: 'Pan speed' },
  { key: 'zoomSpeed', label: 'Zoom speed' },
  { key: 'orbitSpeed', label: 'Orbit speed' },
];

function SettingsPanel({ connect }: { connect: () => Promise<void> }): React.ReactElement {
  const settings = useSpaceMouseStore((s) => s.settings);
  const status = useSpaceMouseStore((s) => s.status);
  const deviceName = useSpaceMouseStore((s) => s.deviceName);
  const message = useSpaceMouseStore((s) => s.message);
  const update = useSpaceMouseStore((s) => s.updateSettings);
  const reset = useSpaceMouseStore((s) => s.resetSettings);

  const toggleInvert = (name: AxisName): void => update({ invert: { ...settings.invert, [name]: !settings.invert[name] } });
  const patchSpeed = (key: keyof SpaceMouseSettings, value: number): void => update({ [key]: value });

  return (
    <div className="space-mouse__panel" role="group" aria-label="3D mouse settings">
      <div className="space-mouse__status">
        <span className={`space-mouse__dot space-mouse__dot--${status}`} aria-hidden="true" />
        {status === 'connected' ? (deviceName ?? '3D mouse') : 'No 3D mouse connected'}
        <button type="button" className="btn" onClick={() => void connect()}>
          {status === 'connected' ? 'Switch device' : 'Connect'}
        </button>
      </div>
      {message !== null && (
        <p className="space-mouse__error" role="alert">
          {message}
        </p>
      )}
      <fieldset className="space-mouse__group">
        <legend>Invert axis</legend>
        {AXIS_NAMES.map((name) => (
          <label key={name} className="space-mouse__check">
            <input type="checkbox" checked={settings.invert[name]} onChange={() => toggleInvert(name)} />
            {AXIS_LABELS[name]}
          </label>
        ))}
      </fieldset>
      {SPEEDS.map(({ key, label }) => (
        <label key={key} className="space-mouse__slider">
          {label}
          <input
            type="range"
            min={SPEED_RANGE.min}
            max={SPEED_RANGE.max}
            step={0.1}
            value={settings[key]}
            onChange={(e) => patchSpeed(key, Number(e.target.value))}
          />
          <output>{settings[key].toFixed(1)}x</output>
        </label>
      ))}
      <label className="space-mouse__check">
        <input type="checkbox" checked={settings.dominantAxis} onChange={(e) => update({ dominantAxis: e.target.checked })} />
        Dominant axis only (one movement at a time)
      </label>
      <button type="button" className="btn" onClick={reset}>
        Reset to defaults
      </button>
    </div>
  );
}

export function SpaceMouseControl(): React.ReactElement | null {
  const { supported, connect } = useSpaceMouse();
  const status = useSpaceMouseStore((s) => s.status);
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <div className="space-mouse">
      {open && <SettingsPanel connect={connect} />}
      <button
        type="button"
        className={`space-mouse__chip${status === 'connected' ? ' space-mouse__chip--on' : ''}`}
        aria-expanded={open}
        aria-label="3D mouse settings"
        title="3D mouse (3Dconnexion SpaceMouse)"
        onClick={() => setOpen((value) => !value)}
      >
        3D mouse
      </button>
    </div>
  );
}

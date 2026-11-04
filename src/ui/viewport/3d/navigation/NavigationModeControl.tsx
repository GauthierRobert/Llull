// Viewport toolbar: Orbit / Walk / Fly. Walk and fly are first-person (WASD, mouse look, Shift boost, Esc back to Orbit); UI-only.

import React from 'react';
import { useNavigationStore } from '@ui/store/navigationStore';
import type { NavigationMode } from './navigationMath';

const MODES: { value: NavigationMode; label: string; title: string }[] = [
  { value: 'orbit', label: 'Orbit', title: 'Orbit — drag to orbit, wheel to zoom' },
  { value: 'walk', label: 'Walk', title: 'Walk — first person at eye height: WASD to move, mouse to look, Shift to run, Esc to leave' },
  { value: 'fly', label: 'Fly', title: 'Fly — free first person: WASD to move, Q/E down/up, mouse to look, Shift to boost, Esc to leave' },
];

export function NavigationModeControl(): React.ReactElement {
  const mode = useNavigationStore((s) => s.mode);
  const setMode = useNavigationStore((s) => s.setMode);
  return (
    <div className="vp-group vp-segmented" role="group" aria-label="Navigation mode">
      {MODES.map(({ value, label, title }) => (
        <button
          key={value}
          type="button"
          className={`vp-btn${mode === value ? ' vp-btn--selected' : ''}`}
          aria-pressed={mode === value}
          aria-label={label}
          title={title}
          onClick={() => setMode(value)}
        >
          <span className="vp-btn__text">{label}</span>
        </button>
      ))}
    </div>
  );
}

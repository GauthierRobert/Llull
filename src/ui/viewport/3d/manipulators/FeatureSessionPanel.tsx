// DOM card beside the grip: the live value box, the join / cut choice (extrusions), the dry run's refusal when there is one, and
// explicit Apply / Cancel. Gathers input only; the session hook commits through the command layer.

import { usePreviewStore } from '@ui/store/previewStore';
import type { BooleanMode, ModeChoice } from './manipulatorMath';
import { ValueBox } from './ValueBox';
import type { FeatureKind } from './featurePlan';

const TITLES: Record<FeatureKind, { title: string; field: string }> = {
  extrude: { title: 'Extrude', field: 'Distance' },
  fillet: { title: 'Fillet', field: 'Radius' },
  shell: { title: 'Shell', field: 'Thickness' },
};

const MODE_CHOICES: ReadonlyArray<{ id: ModeChoice; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'new', label: 'New' },
  { id: 'join', label: 'Join' },
  { id: 'cut', label: 'Cut' },
];

interface FeatureSessionPanelProps {
  kind: FeatureKind;
  unit: string;
  value: number;
  modeChoice: ModeChoice;
  /** Resolved mode of an extrusion (what Auto picked), null for other features. */
  mode: BooleanMode | null;
  bodyId: string | null;
  onValue: (value: number) => void;
  onModeChoice: (choice: ModeChoice) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function FeatureSessionPanel(props: FeatureSessionPanelProps): React.ReactElement {
  const { kind, unit, value, modeChoice, mode, bodyId, onValue, onModeChoice, onCommit, onCancel } = props;
  const outcome = usePreviewStore((s) => s.outcome);
  const copy = TITLES[kind];
  return (
    <div className="feature-session" role="group" aria-label={`${copy.title} handle`}>
      <div className="feature-session__row">
        <strong className="feature-session__title">{copy.title}</strong>
        <ValueBox label={copy.field} unit={unit} value={value} onChange={onValue} onCommit={onCommit} onCancel={onCancel} autoFocus />
      </div>
      {kind === 'extrude' && (
        <div className="feature-session__modes" role="radiogroup" aria-label="Combine with body">
          {MODE_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={modeChoice === choice.id}
              className={`feature-session__mode${modeChoice === choice.id ? ' feature-session__mode--on' : ''}`}
              disabled={choice.id !== 'auto' && choice.id !== 'new' && bodyId === null}
              onClick={() => onModeChoice(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
      {mode !== null && (
        <p className="feature-session__hint">
          {mode === 'new' ? 'New solid' : mode === 'join' ? `Joins ${bodyId ?? ''}` : `Cuts ${bodyId ?? ''}`}
        </p>
      )}
      {outcome !== null && !outcome.ok && (
        <p className="feature-session__refusal" role="alert">
          {outcome.summary}
        </p>
      )}
      <div className="feature-session__actions">
        <button type="button" className="btn btn--primary" onClick={onCommit}>
          Apply
          <kbd className="kbd kbd--on-accent">↵</kbd>
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
          <kbd className="kbd">Esc</kbd>
        </button>
      </div>
    </div>
  );
}

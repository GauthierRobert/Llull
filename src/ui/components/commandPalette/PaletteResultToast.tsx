/**
 * @layer ui/components/commandPalette
 *
 * Result toast for commands run from the palette: the palette closes on run, so the command's
 * `summary` (its feedback signal) is shown here until dismissed or timed out (paused on hover /
 * focus). The live region stays mounted so screen readers announce each new result.
 * Presentation only.
 */

import React, { useEffect, useState } from 'react';
import { usePaletteStore } from '@ui/store';
import type { PaletteResult } from '@ui/store/paletteStore';
import { Icon } from '@ui/components/Icon';
import { humanizeName } from './paramForm';

const TOAST_MS = 6000;

/** One toast; keyed by result id so its pause/timer state never leaks into the next one. */
function ResultCard({ result }: { result: PaletteResult }): React.ReactElement {
  const dismissResult = usePaletteStore((s) => s.dismissResult);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(dismissResult, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [paused, dismissResult]);

  return (
    <div
      className={`palette-toast${result.failed ? ' palette-toast--failed' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="palette-toast__icon" aria-hidden="true">
        <Icon name={result.failed ? 'info' : 'check'} size={14} />
      </span>
      <span className="palette-toast__text">
        <strong className="palette-toast__title">{humanizeName(result.commandName)}</strong>
        <span className="palette-toast__summary">{result.summary}</span>
      </span>
      <button
        type="button"
        className="icon-btn"
        onClick={dismissResult}
        aria-label="Dismiss result"
        title="Dismiss"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function PaletteResultToast(): React.ReactElement {
  const result = usePaletteStore((s) => s.result);
  return (
    <div className="palette-toast-region" role="status" aria-live="polite">
      {result !== null && <ResultCard key={result.id} result={result} />}
    </div>
  );
}

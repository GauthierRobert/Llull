// Viewport overlay: the last commands remote callers (MCP agent, CLI, API) applied to the live document, newest first,
// each fading out on its own, plus the switch for the live-edit animations.

import { useEffect } from 'react';
import { ACTIVITY_MS, useLiveFxStore } from '@ui/store/liveFxStore';
import { liveSourceLabel, type LiveActivity } from '@ui/viewport/liveFx/planLiveFx';
import { toneHex } from '@ui/viewport/liveFx/liveFxTones';
import { Icon } from './Icon';

const PRUNE_INTERVAL_MS = 500;

function changeCounts(entry: LiveActivity): string {
  const parts = [
    entry.created > 0 ? `+${entry.created}` : null,
    entry.modified > 0 ? `~${entry.modified}` : null,
    entry.removed > 0 ? `−${entry.removed}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'no geometry change' : parts.join(' ');
}

function ActivityRow({ entry }: { entry: LiveActivity }): React.ReactElement {
  const style = { '--live-fx-accent': toneHex(entry.source), '--live-fx-life': `${ACTIVITY_MS}ms` } as React.CSSProperties;
  return (
    <li className="live-activity__row" style={style} data-source={entry.source}>
      <span className="live-activity__dot" aria-hidden="true" />
      <span className="live-activity__who">{liveSourceLabel(entry.source, entry.userName)}</span>
      <code className="live-activity__name">{entry.name}</code>
      <span className="live-activity__counts">{changeCounts(entry)}</span>
    </li>
  );
}

export function LiveActivityFeed(): React.ReactElement | null {
  const activity = useLiveFxStore((s) => s.activity);
  const enabled = useLiveFxStore((s) => s.enabled);
  const setEnabled = useLiveFxStore((s) => s.setEnabled);

  // Expire rows even while no viewport frame is drawn (the 3D driver only runs while effects animate).
  useEffect(() => {
    if (activity.length === 0) return undefined;
    const timer = setInterval(() => useLiveFxStore.getState().prune(performance.now()), PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activity.length]);

  if (activity.length === 0) return null;
  return (
    <section className="live-activity" aria-label="Live remote edits" aria-live="polite">
      <header className="live-activity__header">
        <span className="live-activity__pulse" aria-hidden="true" />
        Live edits
        <button
          type="button"
          className="live-activity__toggle"
          onClick={() => setEnabled(!enabled)}
          aria-pressed={enabled}
          title={enabled ? 'Turn live-edit animations off' : 'Turn live-edit animations on'}
        >
          <Icon name="zap" size={12} />
          {enabled ? 'FX on' : 'FX off'}
        </button>
      </header>
      <ol className="live-activity__list">
        {activity.map((entry) => (
          <ActivityRow key={entry.key} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

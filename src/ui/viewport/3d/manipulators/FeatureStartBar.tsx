// Floating chips over the viewport for the sole selected entity: Extrude for a sketch profile, Fillet / Shell for a solid.
// Each starts a drag-handle session (live ghost, one dispatch on release); no document change happens here. None for
// plugin-derived geometry (building elements, implicit bodies…): it is read-only, so the command would be refused.

import { derivedEntityIds } from '@core/plugins/host';
import { useStore } from '@ui/store';
import { useFeatureSessionStore } from '@ui/store/featureSessionStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { type FeatureKind, handleFrame, initialValue } from './featurePlan';

const PROFILE_KINDS: ReadonlySet<string> = new Set(['rectangle', 'circle', 'ellipse', 'polyline', 'spline']);
const NOT_FILLETABLE: ReadonlySet<string> = new Set(['instance']);
const SOLID_KINDS: ReadonlySet<string> = new Set([
  'box',
  'cylinder',
  'sphere',
  'extrusion',
  'mesh',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'revolution',
]);

const LABELS: Record<FeatureKind, string> = { extrude: 'Extrude', fillet: 'Fillet', shell: 'Shell' };

/** Features offered for an entity kind. @pure */
function featuresFor(kind: string): readonly FeatureKind[] {
  if (PROFILE_KINDS.has(kind)) return ['extrude'];
  return SOLID_KINDS.has(kind) && !NOT_FILLETABLE.has(kind) ? ['fillet', 'shell'] : [];
}

export function FeatureStartBar(): React.ReactElement | null {
  const entity = useSoleSelectedEntity();
  const session = useFeatureSessionStore((s) => s.session);
  if (entity === undefined || session !== null) return null;
  // Read at render: a new entity object (the selection or the document changed) re-renders this bar.
  if (derivedEntityIds(useStore.getState().document).has(entity.id)) return null;
  const features = featuresFor(entity.kind);
  if (features.length === 0) return null;

  const start = (kind: FeatureKind): void => {
    const frame = handleFrame(useStore.getState().document, kind, entity.id);
    if (frame !== null) useFeatureSessionStore.getState().start(kind, entity.id, initialValue(kind, frame));
  };

  return (
    <div className="feature-start" role="toolbar" aria-label="Feature handles">
      {features.map((kind) => (
        <button key={kind} type="button" className="feature-start__chip" onClick={() => start(kind)}>
          {LABELS[kind]}
        </button>
      ))}
    </div>
  );
}

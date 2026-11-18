// Chips in the selection bar for the sole selected entity: Extrude for a sketch profile, Fillet / Shell for a solid.
// Each starts a drag-handle session (live ghost, one dispatch on release); no document change happens here. None for
// plugin-derived geometry (building elements, implicit bodies…): it is read-only, so the command would be refused.

import { derivedEntityIds } from '@core/plugins/host';
import type { Entity } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
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
const ICONS: Record<FeatureKind, IconName> = { extrude: 'featureExtrude', fillet: 'modifyFillet', shell: 'featureShell' };
const TIPS: Record<FeatureKind, string> = {
  extrude: 'Pull this sketch into a solid: drag the arrow or type a distance',
  fillet: 'Round the edges: drag the arrow or type a radius',
  shell: 'Hollow it out: drag the arrow or type a wall thickness',
};

/** Features offered for an entity kind. @pure */
function featuresFor(kind: string): readonly FeatureKind[] {
  if (PROFILE_KINDS.has(kind)) return ['extrude'];
  return SOLID_KINDS.has(kind) && !NOT_FILLETABLE.has(kind) ? ['fillet', 'shell'] : [];
}

/** The handle features `entity` offers; none for plugin-derived geometry. */
function offeredFeatures(entity: Entity | undefined): readonly FeatureKind[] {
  if (entity === undefined) return [];
  // Read at call time: a new entity object (the selection or the document changed) re-renders the callers.
  if (derivedEntityIds(useStore.getState().document).has(entity.id)) return [];
  return featuresFor(entity.kind);
}

/**
 * Starts the drag-handle session of `kind` on the sole selected entity (the handles live in the 3D view, so it is shown).
 * False when the selection does not offer that feature: the caller falls back to the command's form.
 */
export function startFeatureOnSelection(kind: FeatureKind): boolean {
  const { document } = useStore.getState();
  const [id] = document.selection;
  const entity = document.selection.length === 1 && id !== undefined ? document.entities[id] : undefined;
  if (entity === undefined || !offeredFeatures(entity).includes(kind)) return false;
  const frame = handleFrame(document, kind, entity.id);
  if (frame === null) return false;
  useToolStore.getState().setViewMode('3d');
  useFeatureSessionStore.getState().start(kind, entity.id, initialValue(kind, frame));
  return true;
}

export function FeatureStartBar(): React.ReactElement | null {
  const entity = useSoleSelectedEntity();
  const session = useFeatureSessionStore((s) => s.session);
  if (session !== null) return null;
  const features = offeredFeatures(entity);
  if (features.length === 0) return null;

  return (
    <div className="feature-start" role="toolbar" aria-label="Feature handles">
      {features.map((kind) => (
        <button key={kind} type="button" className="feature-start__chip" title={TIPS[kind]} onClick={() => startFeatureOnSelection(kind)}>
          <Icon name={ICONS[kind]} size={15} />
          {LABELS[kind]}
        </button>
      ))}
    </div>
  );
}

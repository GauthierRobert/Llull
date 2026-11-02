// Plain module state between the document/store subscriptions, the lighting components and the RenderRig's per-frame
// pass (demand frameloop): nothing here is React state, so writing it never re-renders the scene.

let shadowsDirty = true;

/** The casters, light rig or quality changed: the next frame must re-render the shadow map. */
export function markShadowsDirty(): void {
  shadowsDirty = true;
}

/** Reads and clears the dirty flag (once per rendered frame). */
export function consumeShadowsDirty(): boolean {
  const dirty = shadowsDirty;
  shadowsDirty = false;
  return dirty;
}

let contactBakeTick = 0;
const contactBakeListeners = new Set<() => void>();

/** Asks the mounted ContactShadows to re-bake once (it re-bakes whenever it re-renders with frames={1}). */
export function requestContactBake(): void {
  contactBakeTick += 1;
  for (const listener of contactBakeListeners) listener();
}

export function subscribeContactBake(listener: () => void): () => void {
  contactBakeListeners.add(listener);
  return () => {
    contactBakeListeners.delete(listener);
  };
}

export function getContactBakeTick(): number {
  return contactBakeTick;
}

// Imperative material tweaks of the live-edit effects: a restorable accent glow on live entities, and translucent
// "hologram" clones for ghosts. Only touches objects inside a live-fx wrapper group.

import * as THREE from 'three';

type ColorMaterial = THREE.Material & { color?: unknown; emissive?: unknown; emissiveIntensity?: unknown };

interface SavedLook {
  color: THREE.Color | null;
  emissive: THREE.Color | null;
  emissiveIntensity: number | null;
  /** What `paint` last wrote: a different current value means React set a new one (selection, recolour) → re-snapshot. */
  painted: { color: THREE.Color | null; emissive: THREE.Color | null; emissiveIntensity: number | null } | null;
}

const asColor = (value: unknown): THREE.Color | null => (value instanceof THREE.Color ? value : null);
const intensityOf = (material: ColorMaterial): number | null =>
  typeof material.emissiveIntensity === 'number' ? material.emissiveIntensity : null;

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const material = (object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
  if (material === undefined) return [];
  return Array.isArray(material) ? material : [material];
}

function snapshot(material: ColorMaterial): Pick<SavedLook, 'color' | 'emissive' | 'emissiveIntensity'> {
  return {
    color: asColor(material.color)?.clone() ?? null,
    emissive: asColor(material.emissive)?.clone() ?? null,
    emissiveIntensity: intensityOf(material),
  };
}

const sameColor = (a: THREE.Color | null, b: THREE.Color | null): boolean => (a === null ? b === null : b !== null && a.equals(b));

function changedSincePaint(material: ColorMaterial, look: SavedLook): boolean {
  if (look.painted === null) return false;
  return (
    !sameColor(asColor(material.color), look.painted.color) ||
    !sameColor(asColor(material.emissive), look.painted.emissive) ||
    intensityOf(material) !== look.painted.emissiveIntensity
  );
}

/** Remembers each material's own colours, so `restore` is exact even when React recolours it mid-transition. */
export class GlowTracker {
  private readonly saved = new Map<ColorMaterial, SavedLook>();

  apply(root: THREE.Object3D, accent: THREE.Color, strength: number): void {
    root.traverse((object) => {
      for (const material of materialsOf(object) as ColorMaterial[]) {
        let look = this.saved.get(material);
        if (look === undefined) {
          look = { ...snapshot(material), painted: null };
          this.saved.set(material, look);
        } else if (changedSincePaint(material, look)) {
          Object.assign(look, snapshot(material));
        }
        paint(material, look, accent, strength);
        look.painted = snapshot(material);
      }
    });
  }

  restore(): void {
    for (const [material, look] of this.saved) if (!changedSincePaint(material, look)) paint(material, look, null, 0);
    this.saved.clear();
  }
}

function paint(material: ColorMaterial, look: SavedLook, accent: THREE.Color | null, strength: number): void {
  const emissive = asColor(material.emissive);
  if (emissive !== null && look.emissive !== null) {
    emissive.copy(look.emissive);
    if (accent !== null) emissive.lerp(accent, Math.min(1, strength));
    if (look.emissiveIntensity !== null) material.emissiveIntensity = look.emissiveIntensity + (accent === null ? 0 : strength * 0.6);
    return;
  }
  const color = asColor(material.color);
  if (color !== null && look.color !== null) {
    color.copy(look.color);
    if (accent !== null) color.lerp(accent, Math.min(1, strength * 0.85));
  }
}

/** Swaps every material under `root` for a translucent accent-tinted clone; returns them (opacity is animated) for disposal. */
export function hologramize(root: THREE.Object3D, accent: THREE.Color): THREE.Material[] {
  const clones: THREE.Material[] = [];
  root.traverse((object) => {
    object.raycast = () => undefined;
    object.castShadow = false;
    const holder = object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
    if (holder.material === undefined) return;
    const swap = (material: THREE.Material): THREE.Material => {
      const clone = material.clone() as ColorMaterial;
      clone.transparent = true;
      clone.depthWrite = false;
      const color = asColor(clone.color);
      if (color !== null) color.lerp(accent, 0.55);
      const emissive = asColor(clone.emissive);
      if (emissive !== null) {
        emissive.copy(accent);
        clone.emissiveIntensity = 0.55;
      }
      clones.push(clone);
      return clone;
    };
    holder.material = Array.isArray(holder.material) ? holder.material.map(swap) : swap(holder.material);
  });
  return clones;
}

export function setOpacity(materials: readonly THREE.Material[], opacity: number): void {
  for (const material of materials) material.opacity = opacity;
}

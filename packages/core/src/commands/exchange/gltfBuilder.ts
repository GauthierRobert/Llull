/**
 * glTF 2.0 document builder: one binary buffer holding vertex attributes and PNG images (each
 * view 4-byte aligned), with accessors, textures (one shared REPEAT sampler), materials, meshes and
 * root nodes. Used by the export scene (./gltfScene).
 *
 * @layer core/commands
 * @pure
 */

/** Component-wise min/max of a flat array of `components`-tuples (all-zero when empty). */
function bounds(data: Float32Array, components: number): { min: number[]; max: number[] } {
  const min = Array.from({ length: components }, () => Infinity);
  const max = Array.from({ length: components }, () => -Infinity);
  data.forEach((value, i) => {
    const axis = i % components;
    if (value < (min[axis] as number)) min[axis] = value;
    if (value > (max[axis] as number)) max[axis] = value;
  });
  return Number.isFinite(min[0]) ? { min, max } : { min: min.map(() => 0), max: max.map(() => 0) };
}

/** Accumulates glTF arrays and the BIN payload; `result()` returns the JSON (no buffer uri) + BIN. */
export class GltfBuilder {
  private readonly chunks: Uint8Array[] = [];
  private byteOffset = 0;
  private readonly accessors: Array<Record<string, unknown>> = [];
  private readonly bufferViews: Array<Record<string, unknown>> = [];
  private readonly images: Array<Record<string, unknown>> = [];
  private readonly textures: Array<Record<string, unknown>> = [];
  private readonly materials: Array<Record<string, unknown>> = [];
  private readonly materialIndex = new Map<string, number>();
  private readonly meshes: Array<Record<string, unknown>> = [];
  private readonly nodes: Array<Record<string, unknown>> = [];
  private readonly extensionsUsed = new Set<string>();

  private view(bytes: Uint8Array, target?: number): number {
    const padding = (4 - (this.byteOffset % 4)) % 4;
    if (padding > 0) {
      this.chunks.push(new Uint8Array(padding));
      this.byteOffset += padding;
    }
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteOffset,
      byteLength: bytes.byteLength,
      ...(target !== undefined ? { target } : {}),
    });
    this.chunks.push(bytes);
    this.byteOffset += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  /** FLOAT accessor of `components`-vectors (VEC2 / VEC3); `withBounds` adds min/max (POSITION). */
  vertexData(data: Float32Array, components: 2 | 3, withBounds = false): number {
    const view = this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 34962);
    this.accessors.push({
      bufferView: view,
      componentType: 5126,
      count: data.length / components,
      type: components === 2 ? 'VEC2' : 'VEC3',
      ...(withBounds ? bounds(data, components) : {}),
    });
    return this.accessors.length - 1;
  }

  /** Texture index of an embedded PNG image (repeat-wrapped, mipmapped). */
  texture(png: Uint8Array): number {
    this.images.push({ bufferView: this.view(png), mimeType: 'image/png' });
    this.textures.push({ sampler: 0, source: this.images.length - 1 });
    return this.textures.length - 1;
  }

  /** Material index for `key`, built once by `make` (which may add textures / extensions). */
  material(key: string, make: () => Record<string, unknown>): number {
    const existing = this.materialIndex.get(key);
    if (existing !== undefined) return existing;
    this.materials.push(make());
    this.materialIndex.set(key, this.materials.length - 1);
    return this.materials.length - 1;
  }

  useExtension(name: string): void {
    this.extensionsUsed.add(name);
  }

  /** One triangle mesh + root node. */
  mesh(
    name: string,
    attributes: Record<string, number>,
    material: number,
    extras: Record<string, unknown>,
  ): void {
    this.meshes.push({ name, primitives: [{ attributes, mode: 4, material }] });
    this.nodes.push({ name, mesh: this.meshes.length - 1, extras });
  }

  result(): { json: Record<string, unknown>; bin: Uint8Array } {
    const bin = new Uint8Array(this.byteOffset);
    let offset = 0;
    for (const chunk of this.chunks) {
      bin.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const textured = this.textures.length > 0;
    return {
      json: {
        asset: { version: '2.0', generator: 'llull' },
        ...(this.extensionsUsed.size > 0 ? { extensionsUsed: [...this.extensionsUsed] } : {}),
        scene: 0,
        scenes: [{ nodes: this.nodes.map((_, i) => i) }],
        nodes: this.nodes,
        meshes: this.meshes,
        materials: this.materials,
        ...(textured
          ? {
              images: this.images,
              textures: this.textures,
              samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
            }
          : {}),
        accessors: this.accessors,
        bufferViews: this.bufferViews,
        buffers: [{ byteLength: bin.byteLength }],
      },
      bin,
    };
  }
}

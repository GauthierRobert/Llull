/** Bounds-checked accessor reads for import_gltf: FLOAT vectors and unsigned scalar indices, strided or packed, never past a bufferView. */

import type { GltfBuffers } from './gltfContainer';
import { GltfError, type Json, indexOf, isRecord, listAt } from './gltfJson';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as const;
type AccessorType = keyof typeof COMPONENTS;

const FLOAT = 5126;
/** componentType -> byte size of the unsigned integer index types (UNSIGNED_BYTE / SHORT / INT). */
const INDEX_BYTES: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4 };

/** Resolved layout of one accessor inside its buffer. */
interface Layout {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly stride: number;
  readonly count: number;
  readonly componentType: number;
  readonly width: number;
}

/** Reads accessors of one glTF file. */
export class GltfAccessors {
  private readonly accessors: readonly unknown[];
  private readonly views: readonly unknown[];

  constructor(
    json: Json,
    private readonly buffers: GltfBuffers,
  ) {
    this.accessors = listAt(json, 'accessors', 'glTF');
    this.views = listAt(json, 'bufferViews', 'glTF');
  }

  /** Number of accessors (for index validation by callers). */
  get length(): number {
    return this.accessors.length;
  }

  private layout(index: number, type: AccessorType, componentTypes: readonly number[]): Layout {
    const what = `accessors[${index}]`;
    const accessor = this.accessors[indexOf(index, this.accessors.length, 'accessor index')];
    if (!isRecord(accessor)) throw new GltfError('GLTF_MALFORMED', `${what} must be an object`);
    if (accessor['type'] !== type)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what}.type must be ${type}, got ${JSON.stringify(accessor['type'])}`);
    const componentType = accessor['componentType'];
    if (typeof componentType !== 'number' || !componentTypes.includes(componentType))
      throw new GltfError(
        'GLTF_UNSUPPORTED',
        `${what}.componentType ${JSON.stringify(componentType)} is not supported here (need ${componentTypes.join(' / ')})`,
      );
    if (accessor['sparse'] !== undefined) throw new GltfError('GLTF_UNSUPPORTED', `${what} is sparse`);
    if (accessor['normalized'] === true) throw new GltfError('GLTF_UNSUPPORTED', `${what} is normalized (quantized)`);
    const count = accessor['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what}.count must be a positive integer`);
    if (accessor['bufferView'] === undefined)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what} has no bufferView (zero-filled accessors are not supported)`);
    const view = this.views[indexOf(accessor['bufferView'], this.views.length, `${what}.bufferView`)];
    if (!isRecord(view)) throw new GltfError('GLTF_MALFORMED', `${what}.bufferView must be an object`);
    const buffer = this.buffers.bytes(indexOf(view['buffer'], Number.MAX_SAFE_INTEGER, `${what} bufferView.buffer`));
    const viewOffset = nonNegative(view['byteOffset'], `${what} bufferView.byteOffset`);
    const viewLength = nonNegative(view['byteLength'], `${what} bufferView.byteLength`, false);
    if (viewOffset + viewLength > buffer.length) throw new GltfError('GLTF_BAD_ACCESSOR', `${what} bufferView runs past its buffer`);
    const width = (INDEX_BYTES[componentType] ?? 4) * COMPONENTS[type];
    const declared = view['byteStride'];
    const stride = declared === undefined ? width : nonNegative(declared, `${what} bufferView.byteStride`, false);
    if (stride < width)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what} bufferView.byteStride ${stride} is smaller than one element (${width})`);
    const offset = nonNegative(accessor['byteOffset'], `${what}.byteOffset`);
    if (offset + (count - 1) * stride + width > viewLength)
      throw new GltfError('GLTF_BAD_ACCESSOR', `${what} (${count} x ${type}) runs past its bufferView of ${viewLength} bytes`);
    return { bytes: buffer, start: viewOffset + offset, stride, count, componentType, width };
  }

  /** Values of a FLOAT accessor of `type`, flattened, every one finite. */
  floats(index: number, type: 'VEC2' | 'VEC3' | 'VEC4'): Float64Array {
    const { bytes, start, stride, count } = this.layout(index, type, [FLOAT]);
    const components = COMPONENTS[type];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(count * components);
    for (let i = 0; i < count; i++)
      for (let c = 0; c < components; c++) {
        const value = view.getFloat32(start + i * stride + c * 4, true);
        if (!Number.isFinite(value))
          throw new GltfError('GLTF_BAD_ACCESSOR', `accessors[${index}] holds a non-finite value at element ${i}`);
        out[i * components + c] = value;
      }
    return out;
  }

  /** Values of an unsigned-integer SCALAR index accessor. */
  indices(index: number): Uint32Array {
    const { bytes, start, stride, count, componentType } = this.layout(index, 'SCALAR', Object.keys(INDEX_BYTES).map(Number));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const at = start + i * stride;
      out[i] = componentType === 5121 ? view.getUint8(at) : componentType === 5123 ? view.getUint16(at, true) : view.getUint32(at, true);
    }
    return out;
  }
}

/** A non-negative integer (absent -> 0 unless `optional` is false, which then requires it). */
function nonNegative(value: unknown, what: string, optional = true): number {
  if (value === undefined && optional) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new GltfError('GLTF_BAD_ACCESSOR', `${what} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value;
}

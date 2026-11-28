/**
 * The render reference corpus (RV1 §7 layer V3, docs/QUALITY_GATES.md "Render reference gate"): each scene is a llull document built with
 * registry commands plus the render_realistic params that frame it. The Cycles reference of each is pinned by sha256 in
 * quality/render-reference.json. Textures (a checker PNG, a roughness PNG, a synthetic sky .hdr) are generated here, deterministically.
 */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { encodePng } from '@lib/png';
import { powInt } from '@lib/powInt';

export interface RenderScene {
  readonly id: string;
  readonly doc: CadDocument;
  /** render_realistic params (camera / view, size, bounces); samples and seed are set by the gate. */
  readonly render: Record<string, unknown>;
}

type Builder = (ctx: ExecutionContext) => RenderScene;

class Doc {
  doc: CadDocument = createEmptyDocument();
  constructor(private readonly ctx: ExecutionContext) {}

  run(name: string, params: Record<string, unknown>): string[] {
    const result = execute(this.doc, name, params, this.ctx);
    if (result.error !== undefined || result.rejected === true) throw new Error(`${name}: ${result.summary}`);
    this.doc = result.document;
    return result.affected;
  }

  first(name: string, params: Record<string, unknown>): string {
    const id = this.run(name, params)[0];
    if (id === undefined) throw new Error(`${name} affected nothing`);
    return id;
  }

  material(name: string, appearance: Record<string, unknown>): string {
    this.run('create_material', { name, density: 1000, densityUnit: 'kg/m^3' });
    this.run('set_material_appearance', { material: name, ...appearance });
    return name;
  }

  solid(name: string, params: Record<string, unknown>, material: string): string {
    const id = this.first(name, params);
    this.run('assign_material', { materialName: material, entityIds: [id] });
    return id;
  }

  /** A black environment: only the lights (and emission) light the scene. */
  dark(): void {
    this.run('set_environment', { source: 'color', color: '#000000', intensity: 0 });
  }

  /** A zero-power sun: suppresses render_realistic's default 3 W/m2 sun when the environment is the only light. */
  noDefaultSun(): void {
    this.run('add_light', { lightType: 'sun', intensity: 0, radius: 0 });
  }

  texture(name: string, bytes: Uint8Array, colorSpace: 'srgb' | 'linear'): string {
    const writer = this.ctx.imageAssets as { writeImage?: (bytes: Uint8Array) => string } | null | undefined;
    if (writer?.writeImage === undefined) throw new Error('the render scenes need a writable image asset store');
    const key = writer.writeImage(bytes);
    return this.first('import_texture', { name, fileKey: key, colorSpace });
  }
}

/** ior 1 removes the specular layer: a pure Lambert plate in llull and Cycles alike, so the calibration measures the lights only. */
const LAMBERT = { baseColor: '#bcbcbc', metalness: 0, roughness: 1, ior: 1 };

/** One-light calibration: a 4 x 4 m Lambert plate seen from straight above (orthographic), black environment. */
function calibration(id: string, light: Record<string, unknown>): Builder {
  return (ctx) => {
    const d = new Doc(ctx);
    d.run('set_units', { units: 'm' });
    d.solid('add_box', { size: [4, 4, 0.05], position: [0, 0, -0.025] }, d.material('plate', LAMBERT));
    d.dark();
    d.run('add_light', light);
    return { id, doc: d.doc, render: { view: 'top', projection: 'orthographic', zoom: 1.25, width: 128, height: 128, ground: false } };
  };
}

const cornellBox: Builder = (ctx) => {
  const d = new Doc(ctx);
  d.run('set_units', { units: 'm' });
  // Linear albedos of the classic box: white 0.73, red (0.63, 0.065, 0.05), green (0.14, 0.45, 0.091), as sRGB hex.
  const white = d.material('white', { baseColor: '#dddddd', metalness: 0, roughness: 1 });
  const red = d.material('red', { baseColor: '#d0473e', metalness: 0, roughness: 1 });
  const green = d.material('green', { baseColor: '#68b354', metalness: 0, roughness: 1 });
  const t = 0.02;
  d.solid('add_box', { size: [1, 1, t], position: [0.5, 0.5, -t / 2] }, white);
  d.solid('add_box', { size: [1, 1, t], position: [0.5, 0.5, 1 + t / 2] }, white);
  d.solid('add_box', { size: [1, t, 1], position: [0.5, 1 + t / 2, 0.5] }, white);
  d.solid('add_box', { size: [t, 1, 1], position: [-t / 2, 0.5, 0.5] }, red);
  d.solid('add_box', { size: [t, 1, 1], position: [1 + t / 2, 0.5, 0.5] }, green);
  d.solid('add_box', { size: [0.3, 0.3, 0.6], position: [0.33, 0.62, 0.3], rotation: [0, 0, 0.3] }, white);
  d.solid('add_box', { size: [0.3, 0.3, 0.3], position: [0.68, 0.33, 0.15], rotation: [0, 0, -0.3] }, white);
  d.dark();
  d.run('add_light', { lightType: 'area', position: [0.5, 0.5, 0.995], target: [0.5, 0.5, 0], width: 0.25, height: 0.25, intensity: 15 });
  const camera = d.first('add_camera', { position: [0.5, -1.35, 0.5], target: [0.5, 0.5, 0.5], focalLength: 33, sensorHeight: 24 });
  return { id: 'cornell-box', doc: d.doc, render: { camera, width: 256, height: 256, ground: false, maxBounces: 8 } };
};

/** Four 0.4 m balls on the ground: Lambert, rough metal, glass, red with a clear coat. */
function balls(d: Doc): void {
  d.run('set_units', { units: 'm' });
  d.solid(
    'add_sphere',
    { radius: 0.4, position: [-1.35, 0, 0.4] },
    d.material('lambert', { baseColor: '#b4b4b4', metalness: 0, roughness: 1 }),
  );
  d.solid(
    'add_sphere',
    { radius: 0.4, position: [-0.45, 0, 0.4] },
    d.material('metal', { baseColor: '#e6c38a', metalness: 1, roughness: 0.35 }),
  );
  const glass = 'glass';
  d.run('create_material', { name: glass, density: 2500, densityUnit: 'kg/m^3' });
  d.run('apply_appearance', { appearance: 'glass', material: glass });
  d.solid('add_sphere', { radius: 0.4, position: [0.45, 0, 0.4] }, glass);
  d.solid(
    'add_sphere',
    { radius: 0.4, position: [1.35, 0, 0.4] },
    d.material('coat', { baseColor: '#b02020', metalness: 0, roughness: 0.6, coat: 1, coatRoughness: 0.05 }),
  );
}

const BALL_CAMERA = { position: [0, -4.2, 1.5], target: [0, 0, 0.35], focalLength: 40, sensorHeight: 24 };

const ballsUniform: Builder = (ctx) => {
  const d = new Doc(ctx);
  balls(d);
  d.run('set_environment', { source: 'color', color: '#ffffff', intensity: 1 });
  d.noDefaultSun();
  const camera = d.first('add_camera', BALL_CAMERA);
  return { id: 'balls-uniform', doc: d.doc, render: { camera, width: 320, height: 180, ground: true, maxBounces: 8 } };
};

const ballsHdr: Builder = (ctx) => {
  const d = new Doc(ctx);
  balls(d);
  const sky = d.texture('synthetic_sky', syntheticSkyHdr(256, 128), 'linear');
  d.run('set_environment', { source: 'hdr', texture: sky, rotation: 0.6, intensity: 1 });
  d.noDefaultSun();
  const camera = d.first('add_camera', BALL_CAMERA);
  return { id: 'balls-hdr', doc: d.doc, render: { camera, width: 320, height: 180, ground: true, maxBounces: 8 } };
};

/** A pipe-rack bay in millimetres: instance arrays of pipes (galvanised), beams (steel) and columns (painted), sun + sky colour. */
const plantInstanced: Builder = (ctx) => {
  const d = new Doc(ctx);
  const material = (name: string, appearance: string, color?: string): string => {
    d.run('create_material', { name, density: 7850, densityUnit: 'kg/m^3' });
    d.run('apply_appearance', { appearance, material: name, ...(color !== undefined ? { color } : {}) });
    return name;
  };
  const galvanised = material('galvanised', 'galvanised');
  const steel = material('steel', 'steel');
  const painted = material('painted', 'painted', '#2f5fa8');
  const component = (componentId: string, kind: string, params: Record<string, unknown>): string => {
    const id = d.first(kind, params);
    d.run('create_component', { name: componentId, entityIds: [id], componentId });
    d.run('delete_entities', { ids: d.doc.order.filter((entity) => d.doc.entities[entity]?.kind === 'instance') });
    return componentId;
  };
  const pipe = component('pipe', 'add_cylinder', { radius: 80, height: 6000, axis: [1, 0, 0], position: [3000, 0, 0] });
  const beam = component('beam', 'add_box', { size: [150, 1800, 300], position: [0, 900, 150] });
  const column = component('column', 'add_box', { size: [250, 250, 5000], position: [0, 0, 2500] });
  d.run('add_instance_array', { componentId: column, counts: [4, 2, 1], step: [2000, 1800, 1], materialId: painted });
  d.run('add_instance_array', { componentId: beam, counts: [4, 1, 2], step: [2000, 1, 1500], origin: [0, 0, 3000], materialId: steel });
  d.run('add_instance_array', {
    componentId: pipe,
    counts: [1, 6, 2],
    step: [1, 280, 1500],
    origin: [0, 200, 3380],
    materialId: galvanised,
  });
  d.run('add_light', { lightType: 'sun', position: [0, 0, 10000], target: [-4000, 3000, -6000], intensity: 3, radius: 0.00465 });
  d.run('set_environment', { source: 'color', color: '#9bb8e0', intensity: 0.35 });
  return {
    id: 'plant-instanced',
    doc: d.doc,
    render: { direction: [1.3, -1.8, 0.9], zoom: 1.1, width: 320, height: 200, ground: true, maxBounces: 6 },
  };
};

/** A textured floor and ball (checker base colour, striped roughness) under a point and a spot light. */
const texturedLights: Builder = (ctx) => {
  const d = new Doc(ctx);
  d.run('set_units', { units: 'm' });
  const checker = d.texture('checker', checkerPng(64, 8), 'srgb');
  const stripes = d.texture('stripes', stripesPng(64, 16), 'linear');
  const floor = d.material('floor', {
    baseColor: { value: '#ffffff', texture: checker },
    metalness: 0,
    roughness: { value: 1, texture: stripes },
    uvScale: 1,
  });
  const ball = d.material('ball', { baseColor: { value: '#ffffff', texture: checker }, metalness: 0, roughness: 0.4, uvScale: 0.5 });
  d.solid('add_box', { size: [4, 4, 0.05], position: [0, 0, -0.025] }, floor);
  d.solid('add_sphere', { radius: 0.5, position: [0, 0, 0.5] }, ball);
  d.run('add_light', { lightType: 'point', position: [-1.2, -0.8, 1.6], intensity: 60, radius: 0.05, color: '#ffe0c0' });
  d.run('add_light', { lightType: 'spot', position: [1.4, 1.0, 2.2], target: [0.3, 0.2, 0], intensity: 120, coneAngle: 0.6, blend: 0.25 });
  d.run('set_environment', { source: 'color', color: '#ffffff', intensity: 0.03 });
  const camera = d.first('add_camera', { position: [0.4, -3.2, 1.9], target: [0, 0, 0.3], focalLength: 35, sensorHeight: 24 });
  return { id: 'textured-lights', doc: d.doc, render: { camera, width: 320, height: 240, ground: false, maxBounces: 6 } };
};

/**
 * White furnace of a non-absorbing dielectric: a white (base colour 1) sphere, roughness 0.5, ior 1.5, under a uniform white world with
 * no ground. An energy-preserving material returns radiance ~1 everywhere on the sphere (Cycles 4.0: 0.98).
 */
const furnaceDielectric: Builder = (ctx) => {
  const d = new Doc(ctx);
  d.run('set_units', { units: 'm' });
  d.solid(
    'add_sphere',
    { radius: 0.5, position: [0, 0, 0] },
    d.material('white', { baseColor: '#ffffff', metalness: 0, roughness: 0.5, ior: 1.5 }),
  );
  d.run('set_environment', { source: 'color', color: '#ffffff', intensity: 1 });
  d.noDefaultSun();
  return {
    id: 'furnace-dielectric',
    doc: d.doc,
    render: { view: 'front', projection: 'orthographic', zoom: 1.6, width: 128, height: 128, ground: false, maxBounces: 32 },
  };
};

export const RENDER_SCENES: Readonly<Record<string, Builder>> = {
  'furnace-dielectric': furnaceDielectric,
  'cal-sun': calibration('cal-sun', { lightType: 'sun', position: [0, 0, 5], target: [-0.6, -0.4, 0], intensity: 3, radius: 0 }),
  'cal-point': calibration('cal-point', { lightType: 'point', position: [0, 0, 1.5], intensity: 50, radius: 0.05 }),
  'cal-spot': calibration('cal-spot', {
    lightType: 'spot',
    position: [0, 0, 2],
    target: [0, 0, 0],
    intensity: 50,
    coneAngle: 0.9,
    blend: 0.3,
    radius: 0.05,
  }),
  'cal-area': calibration('cal-area', {
    lightType: 'area',
    position: [0, 0, 1],
    target: [0, 0, 0],
    width: 0.6,
    height: 0.4,
    intensity: 20,
  }),
  'cornell-box': cornellBox,
  'balls-uniform': ballsUniform,
  'balls-hdr': ballsHdr,
  'plant-instanced': plantInstanced,
  'textured-lights': texturedLights,
};

function checkerPng(size: number, cell: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      rgba.set(dark ? [40, 60, 150, 255] : [230, 220, 200, 255], 4 * (y * size + x));
    }
  return encodePng(size, size, rgba, true);
}

function stripesPng(size: number, period: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const value = Math.floor(x / (period / 2)) % 2 === 0 ? 255 : 64;
      rgba.set([value, value, value, 255], 4 * (y * size + x));
    }
  return encodePng(size, size, rgba, true);
}

/** RGBE bytes of one linear value triple (Radiance shared exponent). */
function rgbe(r: number, g: number, b: number): [number, number, number, number] {
  const peak = Math.max(r, g, b);
  if (peak < 1e-32) return [0, 0, 0, 0];
  let exponent = Math.ceil(Math.log2(peak));
  if (peak / powInt(2, exponent) >= 1) exponent += 1;
  const scale = 256 / powInt(2, exponent);
  return [Math.floor(r * scale), Math.floor(g * scale), Math.floor(b * scale), exponent + 128];
}

/**
 * A synthetic equirectangular sky (llull §5b orientation: u = 0.5 + atan2(-y, x) / 2pi, v = 0.5 + asin(z) / pi, row 0 at v = 1): a blue
 * gradient above the horizon, brown ground below, a 4 degree sun of radiance 400 at azimuth 40 / elevation 35 degrees, and an orange
 * patch at azimuth 200 degrees so a wrong rotation or mirror shows. Radiance .hdr with RLE scanlines of literal runs.
 */
function syntheticSkyHdr(width: number, height: number): Uint8Array {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const sun = direction(40, 35);
  const patch = direction(200, 12);
  const body: number[] = [];
  for (let row = 0; row < height; row++) {
    const v = 1 - (row + 0.5) / height;
    const elevation = (v - 0.5) * Math.PI;
    const scan: [number, number, number, number][] = [];
    for (let column = 0; column < width; column++) {
      const u = (column + 0.5) / width;
      const azimuth = -(u - 0.5) * 2 * Math.PI;
      const d = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
      const toSun = Math.acos(Math.min(1, dot(d, sun)));
      const toPatch = Math.acos(Math.min(1, dot(d, patch)));
      let rgb: [number, number, number];
      if (toSun < (4 * Math.PI) / 180) rgb = [400, 380, 340];
      else if (toPatch < (10 * Math.PI) / 180) rgb = [2.0, 0.8, 0.2];
      else if (elevation >= 0) {
        const t = Math.sin(elevation);
        rgb = [0.55 - 0.3 * t, 0.7 - 0.25 * t, 1.0 - 0.1 * t];
      } else rgb = [0.25, 0.18, 0.12];
      scan.push(rgbe(...rgb));
    }
    body.push(2, 2, (width >> 8) & 255, width & 255);
    for (let channel = 0; channel < 4; channel++)
      for (let start = 0; start < width; start += 128) {
        const count = Math.min(128, width - start);
        body.push(count);
        for (let k = 0; k < count; k++) body.push(scan[start + k]?.[channel] ?? 0);
      }
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

function direction(azimuthDeg: number, elevationDeg: number): number[] {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
}

const dot = (a: number[], b: number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

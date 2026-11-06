/** Shared fixtures of the render_animation tests (PHY-22 MOV): the validation plans, the expected values and a decoder for the produced files. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { execute } from '@core/commands/registry';
import { base64ToUint8Array } from '@lib/base64';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { ViewpointCamera } from '@core/model/review';
import { makeProjector } from '@core/commands/render/camera';
import { viewpointView } from '@core/commands/render/viewSetup';
import { plans } from '../golden/plans';

const validation = resolve(process.cwd(), 'docs/physics/22-motion-video/validation');

export interface PlanStep {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

const readPlan = (name: string): PlanStep[] => JSON.parse(readFileSync(resolve(validation, 'plans', name), 'utf8')) as PlanStep[];

export const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(validation, name), 'utf8')) as T;

/** The document of a plan without its last step (the render_animation call). */
export function planDocument(name: string): { document: CadDocument; render: PlanStep } {
  const plan = readPlan(name);
  const render = plan[plan.length - 1] ?? { command: '', params: {} };
  const actions = plan
    .slice(0, -1)
    .map((step) => ({ command: step.command, params: step.params, ...(step.as === undefined ? {} : { as: step.as }) }));
  return { document: execute(createEmptyDocument(), 'build_project', { actions }).document, render };
}

export interface AnimationData {
  frames: number;
  fps: number;
  videoDurationS: number;
  sourceDurationS: number;
  playbackRate: number;
  width: number;
  height: number;
  format: string;
  cameraMode?: string;
  camera: { projection: string; eye: number[]; direction: number[]; up: number[]; viewHeight: number; fovDeg?: number };
  files: { fileName: string; base64: string }[];
  timeline: {
    frame: number;
    tS: number;
    sample?: { before: number; after: number; weight: number };
    camera?: AnimationData['camera'];
    readouts: Record<string, { value: number; unit: string }>;
  }[];
  moving: string[];
  traces?: Record<string, { path: number[][]; at: number[][] }>;
  renderer: string;
  rendererVersion?: string;
  frameSha256?: string[];
  fileSha256?: string;
  sheet?: { frames: number[]; columns: number; width: number; height: number };
  sampleIntervalS?: number;
  warnings: { code: string; message: string }[];
}

export const fileBytes = (data: AnimationData, fileName: string): Uint8Array =>
  base64ToUint8Array(data.files.find((file) => file.fileName === fileName)?.base64 ?? '') ?? new Uint8Array(0);

/** Decoded RGBA of a PNG written by encodePng (8-bit RGBA, one IDAT, filter 0 or 2 "Up"). */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const parts: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(joined);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      rgba[y * stride + x] = filter === 2 && y > 0 ? (value + (rgba[(y - 1) * stride + x] ?? 0)) & 0xff : value;
    }
  }
  return { width, height, rgba };
}

/** Pixel (x, y, y down) of the world point `point` in the image of `data`, through the fixed camera `data.camera`. */
export function pixelOf(data: AnimationData, point: readonly [number, number, number]): [number, number] {
  const view = viewpointView(data.camera as unknown as ViewpointCamera, data.width, data.height, [0, 0, 0]);
  return makeProjector(view.camera, view.orthoHalf, data.width, data.height)(point);
}

/** RGBA of the pixel (x, y) of a decoded image. */
export function pixelAt(image: { width: number; rgba: Uint8Array }, x: number, y: number): number[] {
  const at = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.rgba[at] ?? -1, image.rgba[at + 1] ?? -1, image.rgba[at + 2] ?? -1, image.rgba[at + 3] ?? -1];
}

/** The golden four-bar (three instances moved by three revolute joints, the crank driven) with the ids of its parts. */
export function fourBar(): { document: CadDocument; drive: string; instances: string[] } {
  const actions = (plans['mechanism_four_bar_exploded'] ?? []).slice(0, 10);
  const document = execute(createEmptyDocument(), 'build_project', { actions }).document;
  const drive = Object.keys(document.joints).find((id) => document.joints[id]?.passive !== true) ?? '';
  return { document, drive, instances: document.order.filter((id) => document.entities[id]?.kind === 'instance') };
}

/** The design corpus of the action matrix: oracle parts, golden plans and the quality drawings plans, each a `build_project` action list. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { plans } from '../golden/plans';
import type { Design } from './types';

const ROOT = path.resolve(__dirname, '..', '..');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

function oracleDesigns(): Design[] {
  const dir = path.join(ROOT, 'tests', 'oracle');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      id: `oracle/${name}`,
      corpus: 'oracle' as const,
      actions: (readJson(path.join(dir, name, 'plan.json')) as { actions: unknown[] }).actions,
    }));
}

function qualityDesigns(): Design[] {
  const dir = path.join(ROOT, 'quality', 'drawings', 'plans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const content = readJson(path.join(dir, name));
      const actions = Array.isArray(content) ? content : ((content as { actions?: unknown[] }).actions ?? []);
      return { id: `quality/${name.replace(/\.json$/, '')}`, corpus: 'quality' as const, actions };
    });
}

const goldenDesigns = (): Design[] =>
  Object.keys(plans)
    .sort()
    .map((name) => ({ id: `golden/${name}`, corpus: 'golden' as const, actions: plans[name] ?? [] }));

/** Every design, in a stable order. */
export const loadDesigns = (): Design[] => [...oracleDesigns(), ...goldenDesigns(), ...qualityDesigns()];

/**
 * Rot gate for validation plans: every step (`{ command, params }`, found anywhere in the JSON) of every docs/**\/validation/**\/*.json plan must
 * name a registered command (listCommands()) or a non-registry CLI tool (fea / exchange / library). Plans that reference commands not built
 * yet are tracked in blockedPlanCommands.json (plan path -> sorted missing names).
 *
 * Fails on (a) a missing command not in the allowlist (new rot) and (b) a stale allowlist entry (command now registered, or no longer referenced).
 * Remove entries as commands get built; never add one without a board note (.claude/work/BOARD.md).
 *
 *   UPDATE_BLOCKED_PLANS=1 npx vitest run tests/unit/contract/validationPlanCommands.test.ts   # rewrite blockedPlanCommands.json
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { listCommands } from '@core/commands/registry';
import { buildExchangeToolDefinitions, buildFeaToolDefinitions, buildLibraryToolDefinitions } from '@protocol/index';

const root = process.cwd();
const ALLOWLIST_PATH = resolve(root, 'tests/unit/contract/blockedPlanCommands.json');
const HEADER =
  'Plans under docs/**/validation referencing commands that are not registered yet (plan path -> sorted names). Remove entries as commands get built; never add one without a board note. Regenerate: UPDATE_BLOCKED_PLANS=1 npx vitest run tests/unit/contract/validationPlanCommands.test.ts';

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return path.endsWith('.json') ? [path] : [];
  });
}

function validationPlans(): string[] {
  const docs = resolve(root, 'docs');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) continue;
      if (entry === 'validation') found.push(...jsonFiles(path));
      else walk(path);
    }
  };
  walk(docs);
  // `data/reference/` holds pinned raw tool outputs (e.g. ifcopenshell logs saved as .json), not plans.
  return found
    .map((path) => relative(root, path).split('\\').join('/'))
    .filter((path) => !path.includes('/data/reference/'))
    .sort();
}

/** Step = object with a string `command` and an object `params`; assertion/expectation objects without params are ignored. */
function collectCommands(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCommands(item, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record['command'] === 'string' && typeof record['params'] === 'object' && record['params'] !== null)
    into.add(record['command']);
  for (const value of Object.values(record)) collectCommands(value, into);
}

function registeredNames(): Set<string> {
  const names = new Set(listCommands().map((command) => command.name));
  for (const build of [buildFeaToolDefinitions, buildExchangeToolDefinitions, buildLibraryToolDefinitions]) {
    for (const tool of build()) names.add(tool.name);
  }
  return names;
}

const registered = registeredNames();
const plans = validationPlans();
const referenced = new Map<string, string[]>();
for (const plan of plans) {
  const names = new Set<string>();
  collectCommands(JSON.parse(readFileSync(resolve(root, plan), 'utf8')), names);
  if (names.size > 0) referenced.set(plan, [...names].sort());
}
const missing: Record<string, string[]> = {};
for (const [plan, names] of referenced) {
  const absent = names.filter((name) => !registered.has(name));
  if (absent.length > 0) missing[plan] = absent;
}

if (process.env['UPDATE_BLOCKED_PLANS']) {
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify({ _comment: HEADER, blocked: missing }, null, 2)}\n`);
}
const allowlist = (JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { blocked: Record<string, string[]> }).blocked;

describe('validation plans reference registered commands', () => {
  it('finds plans with steps', () => {
    expect(plans.length).toBeGreaterThan(50);
    expect(referenced.size).toBeGreaterThan(20);
  });

  it('has no unregistered command outside the allowlist (new rot)', () => {
    const rot: string[] = [];
    for (const [plan, names] of Object.entries(missing)) {
      const allowed = new Set(allowlist[plan] ?? []);
      for (const name of names) if (!allowed.has(name)) rot.push(`${plan}: ${name}`);
    }
    expect(rot, 'register the command or (with a board note) allowlist it').toEqual([]);
  });

  it('has no stale allowlist entry (built, unreferenced or plan gone)', () => {
    const stale: string[] = [];
    for (const [plan, names] of Object.entries(allowlist)) {
      const stillMissing = new Set(missing[plan] ?? []);
      for (const name of names) if (!stillMissing.has(name)) stale.push(`${plan}: ${name}`);
    }
    expect(stale, 'remove from blockedPlanCommands.json').toEqual([]);
  });
});

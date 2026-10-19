/**
 * `llull skills list | path | install [--dir D] [--force]` (SC-A1): the user-facing agent skills (`skills/llull-*` in the repo,
 * `resources/skills` in the desktop app) copied into a Claude Code skills folder (default `~/.claude/skills`). Files only.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { booleanFlag, stringFlag, type ParsedArgv } from './argv';

export interface SkillsIo {
  readonly stdout: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class SkillsUsageError extends Error {}

/** A folder holding one sub-folder per skill, each with a SKILL.md. */
const isSkillsDir = (dir: string): boolean => fs.existsSync(path.join(dir, 'llull-modeling', 'SKILL.md'));

/** Where the shipped skills are: $LLULL_SKILLS_DIR, the desktop resources folder, or a `skills/` above this CLI (repo or bundle). */
export function skillsSourceDir(
  env: Readonly<Record<string, string | undefined>>,
  starts: readonly string[] = defaultStarts(),
): string | null {
  const override = env['LLULL_SKILLS_DIR'];
  if (override !== undefined && override !== '') return isSkillsDir(override) ? override : null;
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 6; depth++) {
      if (isSkillsDir(path.join(dir, 'skills'))) return path.join(dir, 'skills');
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function defaultStarts(): string[] {
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  const script = process.argv[1];
  return [
    ...(typeof resources === 'string' ? [resources] : []),
    ...(script !== undefined ? [path.dirname(script)] : []),
    __dirname,
    process.cwd(),
  ];
}

interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
}

/** `name:` / `description:` of a SKILL.md frontmatter. */
export function skillFrontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (key: string): string | undefined => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();
  const name = field('name');
  const description = field('description');
  return { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
}

function listSkills(source: string): SkillInfo[] {
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, 'SKILL.md')))
    .map((entry) => {
      const dir = path.join(source, entry.name);
      const meta = skillFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
      return { name: meta.name ?? entry.name, description: meta.description ?? '', dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Relative file paths under `dir`, sorted. */
function filesUnder(dir: string, prefix = ''): string[] {
  return fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory() ? filesUnder(dir, relative) : [relative];
    })
    .sort();
}

function sameTree(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  const left = filesUnder(a);
  const right = filesUnder(b);
  return (
    left.length === right.length &&
    left.every((file, k) => file === right[k] && fs.readFileSync(path.join(a, file)).equals(fs.readFileSync(path.join(b, file))))
  );
}

const defaultTarget = (env: SkillsIo['env']): string => path.join(env['HOME'] ?? env['USERPROFILE'] ?? os.homedir(), '.claude', 'skills');

function install(source: string, target: string, force: boolean, io: SkillsIo): number {
  const lines: string[] = [];
  let refused = 0;
  for (const skill of listSkills(source)) {
    const destination = path.join(target, path.basename(skill.dir));
    if (sameTree(skill.dir, destination)) {
      lines.push(`  ${skill.name}: up to date`);
      continue;
    }
    if (fs.existsSync(destination) && !force) {
      refused++;
      lines.push(`  ${skill.name}: ${destination} exists and differs; kept (pass --force to replace it)`);
      continue;
    }
    const existed = fs.existsSync(destination);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(skill.dir, destination, { recursive: true });
    lines.push(`  ${skill.name}: ${existed ? 'replaced' : 'installed'}`);
  }
  io.stdout([`llull skills -> ${target}`, ...lines].join('\n'));
  return refused > 0 ? 1 : 0;
}

/** Dispatch `llull skills <list|path|install>`. */
export function skillsCli(args: ParsedArgv, io: SkillsIo): number {
  const action = args.positionals[1] ?? 'list';
  const source = skillsSourceDir(io.env);
  if (source === null)
    throw new SkillsUsageError('the llull skills folder was not found (set LLULL_SKILLS_DIR to the folder holding llull-modeling/ ...).');
  switch (action) {
    case 'path':
      io.stdout(source);
      return 0;
    case 'list': {
      const skills = listSkills(source);
      io.stdout(
        booleanFlag(args, 'json')
          ? JSON.stringify(skills.map(({ name, description }) => ({ name, description })))
          : skills.map((skill) => `${skill.name}  ${skill.description}`).join('\n'),
      );
      return 0;
    }
    case 'install':
      return install(source, path.resolve(stringFlag(args, 'dir') ?? defaultTarget(io.env)), booleanFlag(args, 'force'), io);
    default:
      throw new SkillsUsageError(`unknown skills action "${action}"; use: llull skills list | path | install [--dir D] [--force]`);
  }
}

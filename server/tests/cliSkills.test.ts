/** `llull skills list | path | install` (SC-A1): finds the shipped skills from the repo or a packaged resources folder, installs them. */

import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { skillFrontmatter, skillsSourceDir } from '../src/cli/skills';

const REPO_SKILLS = path.resolve(__dirname, '../../skills');
const NAMES = ['llull-checking', 'llull-editing', 'llull-mechanisms', 'llull-modeling'];

function capture(env: Record<string, string> = {}): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: () => Promise.resolve(''),
      env,
      prepareKernel: () => Promise.resolve(),
    },
    out,
    err,
  };
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-skills-'));
});

describe('skills source folder', () => {
  it('is found above the CLI in the repo and in a packaged resources layout', () => {
    expect(skillsSourceDir({})).toBe(REPO_SKILLS);
    const resources = path.join(dir, 'resources');
    cpSync(REPO_SKILLS, path.join(resources, 'skills'), { recursive: true });
    mkdirSync(path.join(resources, 'server', 'dist'), { recursive: true });
    expect(skillsSourceDir({}, [path.join(resources, 'server', 'dist')])).toBe(path.join(resources, 'skills'));
    expect(skillsSourceDir({ LLULL_SKILLS_DIR: path.join(resources, 'skills') })).toBe(path.join(resources, 'skills'));
    expect(skillsSourceDir({ LLULL_SKILLS_DIR: dir })).toBeNull();
    expect(skillsSourceDir({}, [path.parse(dir).root])).toBeNull();
  });

  it('reads name and description from the frontmatter', () => {
    expect(skillFrontmatter('---\r\nname: a\r\ndescription: does b\r\n---\nbody')).toEqual({ name: 'a', description: 'does b' });
    expect(skillFrontmatter('no frontmatter')).toEqual({});
  });
});

describe('llull skills', () => {
  it('lists the four skills (text and JSON) and prints the folder', async () => {
    const text = capture();
    expect(await runCli(['skills', 'list'], text.io)).toBe(EXIT_OK);
    expect(
      text.out
        .join('\n')
        .split('\n')
        .map((line) => line.split('  ')[0]),
    ).toEqual(NAMES);
    const json = capture();
    await runCli(['skills', '--json'], json.io);
    expect((JSON.parse(json.out.join('')) as { name: string; description: string }[]).every((s) => s.description.length > 40)).toBe(true);
    const where = capture();
    await runCli(['skills', 'path'], where.io);
    expect(where.out).toEqual([REPO_SKILLS]);
  });

  it('installs into --dir, is idempotent, keeps changed copies unless --force', async () => {
    const target = path.join(dir, 'claude', 'skills');
    const first = capture();
    expect(await runCli(['skills', 'install', '--dir', target], first.io)).toBe(EXIT_OK);
    expect(first.out.join('')).toMatch(/llull-modeling: installed/);
    for (const name of NAMES)
      expect(readFileSync(path.join(target, name, 'SKILL.md'), 'utf8')).toBe(
        readFileSync(path.join(REPO_SKILLS, name, 'SKILL.md'), 'utf8'),
      );

    const again = capture();
    expect(await runCli(['skills', 'install', '--dir', target], again.io)).toBe(EXIT_OK);
    expect(again.out.join('').match(/up to date/g)).toHaveLength(4);

    writeFileSync(path.join(target, 'llull-editing', 'SKILL.md'), 'my local edit');
    const kept = capture();
    expect(await runCli(['skills', 'install', '--dir', target], kept.io)).toBe(EXIT_COMMAND_ERROR);
    expect(kept.out.join('')).toMatch(/llull-editing: .* exists and differs; kept \(pass --force/);
    expect(readFileSync(path.join(target, 'llull-editing', 'SKILL.md'), 'utf8')).toBe('my local edit');

    const forced = capture();
    expect(await runCli(['skills', 'install', '--dir', target, '--force'], forced.io)).toBe(EXIT_OK);
    expect(forced.out.join('')).toMatch(/llull-editing: replaced/);
    expect(readFileSync(path.join(target, 'llull-editing', 'SKILL.md'), 'utf8')).toMatch(/^---\r?\nname: llull-editing/);
  });

  it('defaults to ~/.claude/skills (HOME)', async () => {
    const c = capture({ HOME: dir });
    expect(await runCli(['skills', 'install'], c.io)).toBe(EXIT_OK);
    expect(existsSync(path.join(dir, '.claude', 'skills', 'llull-mechanisms', 'SKILL.md'))).toBe(true);
  });

  it('reports a missing folder and an unknown action as usage errors', async () => {
    const missing = capture({ LLULL_SKILLS_DIR: dir });
    expect(await runCli(['skills', 'list'], missing.io)).toBe(EXIT_USAGE);
    expect(missing.err.join('')).toMatch(/skills folder was not found/);
    const unknown = capture();
    expect(await runCli(['skills', 'remove'], unknown.io)).toBe(EXIT_USAGE);
    expect(unknown.err.join('')).toMatch(/unknown skills action "remove"/);
  });
});

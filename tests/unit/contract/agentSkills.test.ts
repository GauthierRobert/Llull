/**
 * SC-A1: the user-facing agent skills (skills/llull-*) only name commands that exist. Every `"command": "x"` in a plan, every
 * `llull x` call and every backticked snake_case word must be a registry command or a protocol host tool, unless it is a known
 * parameter value listed below.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getCommand } from '@core/commands/registry';
import { buildExchangeToolDefinitions, buildFeaToolDefinitions, buildLibraryToolDefinitions } from '@protocol/index';

const SKILLS_DIR = path.resolve(__dirname, '../../../skills');
const EXPECTED_SKILLS = ['llull-checking', 'llull-editing', 'llull-mechanisms', 'llull-modeling'];
/** `llull <subcommand>` words that are CLI subcommands, not registry commands. */
const CLI_SUBCOMMANDS = new Set([
  'run',
  'exec',
  'list',
  'search',
  'describe',
  'toolsets',
  'guide',
  'status',
  'new',
  'undo',
  'redo',
  'skills',
  'fuzz',
  'help',
]);
/** snake_case words in backticks that are parameter values or result fields, not commands. */
const NOT_COMMANDS = new Set(['through_all', 'torque_curve', 'not_run']);

const hostTools = new Set(
  [...buildExchangeToolDefinitions(), ...buildFeaToolDefinitions(), ...buildLibraryToolDefinitions()].map((t) => t.name),
);
const exists = (name: string): boolean => getCommand(name) !== undefined || hostTools.has(name);

function referencedCommands(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/"command":\s*"([a-z0-9_]+)"/g)) if (match[1] !== undefined) names.add(match[1]);
  for (const match of text.matchAll(/\bllull ([a-z][a-z0-9_]*)/g))
    if (match[1] !== undefined && !CLI_SUBCOMMANDS.has(match[1]) && match[1].includes('_')) names.add(match[1]);
  for (const match of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g))
    if (match[1] !== undefined && !NOT_COMMANDS.has(match[1])) names.add(match[1]);
  return names;
}

describe('agent skills (skills/llull-*)', () => {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  it('ships the four skills, each with name/description frontmatter matching its folder', () => {
    expect(skills.map((entry) => entry.name).sort()).toEqual(EXPECTED_SKILLS);
    for (const entry of skills) {
      const text = readFileSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\r?\\nname: ${entry.name}\\r?\\ndescription: .{40,}`));
    }
  });

  it('names only commands that exist in the registry', () => {
    for (const entry of skills) {
      const names = referencedCommands(readFileSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8'));
      expect(names.size, entry.name).toBeGreaterThan(5);
      expect(
        [...names].filter((name) => !exists(name)),
        entry.name,
      ).toEqual([]);
    }
  });
});

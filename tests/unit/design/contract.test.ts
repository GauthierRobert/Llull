/**
 * Contracts between the design language and the registry it rides on, so a registry change breaks a test instead of silently breaking
 * designs: reserved words, sugar keys, angle units, metrics, generated syntax, and the removability law.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCommand, listCommands } from '@core/commands/registry';
import type { ParamItemSpec } from '@core/commands/types';
import { RESERVED_WORDS } from '@design/parse';
import { SUGAR_KEYS } from '@design/schemaValue';
import { ANGLE_PARAMS } from '@design/units';
import { METRICS } from '@design/checks';
import { commandSyntax } from '@design/syntax';
import { DESIGN_COMMANDS } from '@design/run';
import { designPlugin } from '@design/index';

const root = join(import.meta.dirname, '..', '..', '..');

describe('registry contracts', () => {
  it('no reserved word is a command name', () => {
    expect(RESERVED_WORDS.filter((word) => getCommand(word) !== undefined)).toEqual([]);
  });

  it('commands that own a param named like a sugar key keep it (known list)', () => {
    const owners = listCommands()
      .filter((c) => SUGAR_KEYS.some((key) => c.paramsSchema.properties[key] !== undefined))
      .map((c) => c.name);
    expect(owners).toEqual(['calibrate_underlay']);
  });

  it('every ANGLE_PARAMS entry names a numeric param of a registered command', () => {
    for (const key of Object.keys(ANGLE_PARAMS)) {
      const [command = '', ...path] = key.split('.');
      let spec: ParamItemSpec | undefined = getCommand(command)?.paramsSchema.properties[path[0] ?? ''];
      for (const segment of path.slice(1)) spec = spec?.properties?.[segment];
      const leaf = spec?.type === 'array' ? spec.items : spec;
      expect(leaf?.type, key).toBe('number');
      expect(spec?.description, key).toMatch(ANGLE_PARAMS[key] === 'rad' ? /radian/i : /degree/i);
    }
  });

  it('every metric reads through a registered read-only command', () => {
    for (const [name, metric] of Object.entries(METRICS)) expect(getCommand(metric.command)?.annotations?.readOnly, name).toBe(true);
  });

  it('every registered command has a generated .lld line', () => {
    for (const command of listCommands()) {
      const expected =
        command.annotations?.readOnly === true ? `^check ${command.name} .*path=<data path> expect` : `^${command.name} <alias>`;
      expect(commandSyntax(command.name)).toMatch(new RegExp(expected));
    }
    expect(commandSyntax('nope')).toBeNull();
  });

  it('the plugin contributes exactly the design commands', () => {
    expect(designPlugin.commands.map((c) => c.name).sort()).toEqual([...DESIGN_COMMANDS].sort());
  });
});

describe('removability (docs/DESIGN_LANGUAGE.md §2)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name === 'dist') return [];
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mts|cjs|mjs)$/.test(name) ? [path] : [];
    });

  it('only the composition root imports the design package', () => {
    const sources = ['packages', 'src', 'server/src', 'desktop/src'].flatMap((dir) => files(join(root, dir)));
    const importers = sources
      .map((path) => relative(root, path).replaceAll('\\', '/'))
      .filter((path) => !path.startsWith('packages/design-lang/'))
      .filter((path) => /from '@design\/|packages\/design-lang/.test(readFileSync(join(root, path), 'utf8')));
    expect(importers).toEqual(['src/app/plugins.ts']);
  });
});

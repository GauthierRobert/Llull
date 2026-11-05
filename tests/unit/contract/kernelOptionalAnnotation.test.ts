import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listCommands } from '@core/commands/registry';

/** Command names of the first `defineCommand` that follows a doc-comment line saying `kernel-optional` in a source file. */
function taggedCommands(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path);
      } else if (path.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const tag of text.matchAll(/^\s*\*[^\n]*kernel-optional/gm)) {
          const next = /defineCommand\(\{\s*name: ([^,]+),/.exec(text.slice(tag.index));
          if (next === null) continue; // a helper's tag: no command follows in the file
          const name = (next[1] ?? '').trim();
          const constant = new RegExp(`const ${name} = '([^']+)'`).exec(text);
          found.push(/^'([^']+)'$/.exec(name)?.[1] ?? constant?.[1] ?? `${path}: ${name}`);
        }
      }
    }
  };
  for (const pkg of readdirSync(resolve(__dirname, '../../../packages'))) walk(resolve(__dirname, '../../../packages', pkg, 'src'));
  return found;
}

describe('kernelOptional annotation (TR-INT-09)', () => {
  const annotated = listCommands()
    .filter((command) => command.annotations?.kernelOptional === true)
    .map((command) => command.name);

  it('every command tagged @invariant kernel-optional is annotated kernelOptional: true', () => {
    expect(taggedCommands().filter((name) => !annotated.includes(name))).toEqual([]);
  });

  it('every annotated command carries the tag', () => {
    const tagged = taggedCommands();
    expect(annotated.filter((name) => !tagged.includes(name))).toEqual([]);
    expect(annotated.length).toBeGreaterThanOrEqual(18);
  });
});

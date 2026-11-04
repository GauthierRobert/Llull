#!/usr/bin/env node
/** Parse every src/**\/*.css with PostCSS (the Vite parser) so an unclosed block fails here, not in the desktop build. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('src');

function* cssFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* cssFiles(path);
    else if (name.endsWith('.css')) yield path;
  }
}

let failures = 0;
let count = 0;
for (const root of roots) {
  for (const file of cssFiles(root)) {
    count += 1;
    try {
      postcss.parse(readFileSync(file, 'utf8'), { from: file });
    } catch (error) {
      failures += 1;
      const { line, column, reason } = error;
      console.error(`${file}:${line ?? 1}:${column ?? 1} ${reason ?? error.message}`);
    }
  }
}
if (failures > 0) process.exit(1);
console.warn(`check:css ok (${count} files)`);

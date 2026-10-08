#!/usr/bin/env node
/**
 * PostToolUse (Edit|Write|MultiEdit) — one process per edit:
 * 1. Formats the edited file with the repo's Prettier (in-process, only files `npm run format` covers).
 * 2. Non-blocking reminders (console.log, command-layer obligations, misplaced defineCommand).
 * Always exits 0 (fails open).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORMATTED = [
  /^src\/.*\.tsx?$/,
  /^packages\/[^/]+\/src\/.*\.ts$/,
  /^tests\/.*\.tsx?$/,
  /^server\/(src|tests|examples)\/.*\.ts$/,
  /^quality\/.*\.mjs$/,
];

async function main() {
  const data = await readStdin();
  const input = data.tool_input ?? {};
  const absolutePath = String(input.file_path ?? '');
  if (!absolutePath) return;
  const root = (data.cwd ?? process.cwd()).replace(/\\/g, '/').replace(/\/$/, '');
  const filePath = absolutePath.replace(/\\/g, '/').replace(root + '/', '');

  const notes = [];
  const formatError = await formatFile(absolutePath, filePath);
  if (formatError) notes.push(`prettier could not format ${filePath}: ${formatError}`);

  const text = collectText(input);
  if (/\bconsole\.log\s*\(/.test(text))
    notes.push('console.log present — remove before commit (console.warn/error allowed). [conventions C6]');
  if (/^packages\/(core\/src\/commands|domain-[^/]+\/src)\//.test(filePath))
    notes.push(
      'Command layer changed — defineCommand + registered (registry.ts or plugin commands), happy + ' +
        'failure + `is pure` tests, then `npm run check`. [rules/commands.md]',
    );
  if (/\.(ts|tsx)$/.test(filePath) && /\bdefineCommand\s*\(/.test(text) && !/^(packages\/[^/]+\/src|tests)\//.test(filePath))
    notes.push('defineCommand outside packages/*/src — commands belong in core or a plugin. [architecture L1]');

  if (notes.length === 0) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'llull:\n- ' + notes.join('\n- ') },
    }),
  );
}

async function formatFile(absolutePath, filePath) {
  if (!FORMATTED.some((re) => re.test(filePath))) return '';
  const prettierEntry = resolve('node_modules/prettier/index.mjs');
  if (!existsSync(prettierEntry) || !existsSync(absolutePath)) return '';
  try {
    const prettier = await import(pathToFileURL(prettierEntry).href);
    const source = readFileSync(absolutePath, 'utf8');
    const options = (await prettier.resolveConfig(absolutePath)) ?? {};
    const formatted = await prettier.format(source, { ...options, filepath: absolutePath });
    if (formatted !== source) writeFileSync(absolutePath, formatted);
    return '';
  } catch (error) {
    return String(error?.message ?? error).split('\n')[0];
  }
}

function collectText(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}
async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
main()
  .catch(() => {})
  .finally(() => process.exit(0));

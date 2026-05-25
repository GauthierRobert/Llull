#!/usr/bin/env node
/**
 * PostToolUse advisor — non-blocking nudges after Edit/Write.
 * - console.log left in source -> remind.
 * - command layer changed -> remind about test + coverage gate + registry.
 * Always exits 0. Emits guidance via additionalContext (and plain stdout fallback).
 */
async function main() {
  const data = await readStdin();
  const input = data.tool_input ?? {};
  const filePath = String(input.file_path ?? '').replace(/\\/g, '/');
  const text = collectText(input);
  if (!filePath) return done();

  const notes = [];

  if (/\bconsole\.log\s*\(/.test(text))
    notes.push('console.log present — remove before commit (console.warn/error allowed). [conventions C7]');

  const isCommandLayer = /\/src\/core\/commands\//.test(filePath) || /^src\/core\/commands\//.test(filePath);
  if (isCommandLayer) {
    notes.push('Command layer changed — ensure: registered in registry.ts, has happy + failure-path tests, ' +
      'purity asserted, then run `npm run check` (coverage gate 90/85/90/90 on core/commands/**). [add-command]');
  }
  if (/CommandDefinition\s*</.test(text) && !isCommandLayer)
    notes.push('A CommandDefinition appears outside core/commands — commands belong in core/commands. [architecture L1]');

  if (notes.length === 0) return done();
  const msg = 'llull reminders:\n- ' + notes.join('\n- ');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
  }));
  done();
}

function collectText(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}
function done() { process.exit(0); }
async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
main().catch(() => process.exit(0));

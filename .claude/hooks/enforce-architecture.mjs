#!/usr/bin/env node
/**
 * PreToolUse guard (Edit|Write|MultiEdit). Blocks:
 * - architecture L2: react / DOM / fetch in any `packages/<name>/src/`; `packages/core` importing
 *   another package (plugins/kernels/mcp depend on core, never the reverse).
 * - conventions C1: `any` newly introduced in TS source (packages, src, server/src).
 * - conventions C6: an eslint-disable of `max-lines` (split the file instead).
 * - workflow: `.only(` / `.skip(` newly introduced in a test (focus/skip silently drops coverage).
 * C1/C6/test checks fire only when the edit INTRODUCES the pattern (count rises vs old text), so
 * pre-existing, deliberate occurrences stay editable. Fails open: internal error exits 0.
 * Block: JSON permissionDecision deny + stderr + exit 2.
 */
import { existsSync, readFileSync } from 'node:fs';

async function main() {
  const data = await readStdin();
  const input = data.tool_input ?? {};
  const filePath = String(input.file_path ?? '').replace(/\\/g, '/');
  if (!filePath) return ok();
  const newText = collectText(input, 'new_string');
  if (!newText) return ok();

  const violations = [];
  const inPackage = /(^|\/)packages\/[^/]+\/src\//.test(filePath);
  const isTs = /\.(ts|tsx|mts)$/.test(filePath);
  const isTest = /(^|\/)(tests|server\/tests)\//.test(filePath) || /\.test\.tsx?$/.test(filePath);

  if (inPackage) {
    const inCore = /(^|\/)packages\/core\/src\//.test(filePath);
    if (/from\s+['"]react(-dom)?['"]/.test(newText) || /from\s+['"]@react-three\//.test(newText) || /^\s*import\s+React\b/m.test(newText))
      violations.push('react / react-three import in a library package (architecture L2)');
    if (/\bfetch\s*\(/.test(newText)) violations.push('fetch() in a library package (architecture L2)');
    if (/\bwindow\./.test(newText)) violations.push('window.* in a library package (architecture L2)');
    if (/\blocalStorage\b/.test(newText)) violations.push('localStorage in a library package (architecture L2)');
    if (/\bdocument\.(getElementById|querySelector|createElement|body|cookie|addEventListener)\b/.test(newText))
      violations.push('document.* DOM global in a library package (architecture L2)');
    if (inCore && /from\s+['"]@(aec|mcp|kernel-manifold|kernel-occt)\//.test(newText))
      violations.push('packages/core importing another package — core must not depend on plugins/kernels/mcp (architecture L2/L10)');
  }

  const oldText = collectOldText(input, filePath);
  const introduced = (re) => count(stripStringsAndComments(newText), re) > count(stripStringsAndComments(oldText), re);
  const introducedRaw = (re) => count(newText, re) > count(oldText, re);

  if (isTs && !isTest && /(^|\/)(packages\/[^/]+\/src|src|server\/src)\//.test(filePath) && introduced(/(:\s*any\b|\bas\s+any\b|<any>|\bany\[\])/g))
    violations.push('`any` type introduced — use `unknown` + narrowing or a precise type (conventions C1)');
  if (introducedRaw(/eslint-disable[^\n]*max-lines/g))
    violations.push('eslint-disable of max-lines — split the file by concern instead (conventions C6)');
  if (isTest && introduced(/\b(it|test|describe)\.(only|skip)\s*\(/g))
    violations.push('.only( / .skip( introduced in a test — never focus or skip tests to get green (workflow W1)');

  if (violations.length === 0) return ok();
  const reason =
    `llull guard blocked edit to ${filePath}:\n- ${violations.join('\n- ')}\n` +
    `See .claude/rules/. If this is a genuine exception, ask the user.`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  );
  process.stderr.write(reason + '\n');
  process.exit(2);
}

function count(text, re) {
  return (text.match(re) ?? []).length;
}

/** Blanks string/template literals and comments so `'Mode: any'` or `// any` never trip the `any` check. */
function stripStringsAndComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

function collectText(input, key) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input[key] === 'string') return input[key];
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.[key] ?? '').join('\n');
  return '';
}

/** Edit/MultiEdit: the replaced text. Write: the file currently on disk (empty for a new file). */
function collectOldText(input, filePath) {
  if (typeof input.content === 'string') {
    try {
      return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    } catch {
      return '';
    }
  }
  return collectText(input, 'old_string');
}

function ok() {
  process.exit(0);
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
main().catch(() => process.exit(0));

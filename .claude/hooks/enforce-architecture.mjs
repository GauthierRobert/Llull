#!/usr/bin/env node
/**
 * PreToolUse guard — enforces architecture L2: `core/` is framework-agnostic.
 * Blocks any Edit/Write that introduces react / DOM / fetch into `src/core/`.
 * Fails open: any internal error exits 0 (never wedge the session).
 *
 * Block mechanism: write reason to stderr + exit 2 (universally supported), and
 * also emit the JSON permissionDecision for newer harness versions.
 */
async function main() {
  const data = await readStdin();
  const input = data.tool_input ?? {};
  const filePath = String(input.file_path ?? '').replace(/\\/g, '/');

  // Only police source under src/core. Tests, docs, .claude, ui, server are exempt.
  if (!/\/src\/core\//.test(filePath) && !/^src\/core\//.test(filePath)) return ok();

  const text = collectText(input);
  if (!text) return ok();

  const violations = [];
  if (/from\s+['"]react(-dom)?['"]/.test(text) || /from\s+['"]@react-three\//.test(text) || /^\s*import\s+React\b/m.test(text))
    violations.push('react / react-three import');
  if (/\bfetch\s*\(/.test(text)) violations.push('fetch() call');
  if (/\bwindow\./.test(text)) violations.push('window.* (DOM global)');
  if (/\blocalStorage\b/.test(text)) violations.push('localStorage (DOM global)');
  if (/\bdocument\.(getElementById|querySelector|createElement|body|cookie|addEventListener)\b/.test(text))
    violations.push('document.* (DOM global)');

  if (violations.length === 0) return ok();

  const reason =
    `llull architecture L2 violation in core/ (${filePath}): ${violations.join(', ')}.\n` +
    `core/ is framework-agnostic — no react, DOM, window, or fetch. Move this to ui/ ` +
    `or server/, or inject it behind an interface. See .claude/rules/architecture.md.`;

  // Newer harness: structured deny.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  // Universal: stderr + exit 2 blocks the tool call.
  process.stderr.write(reason + '\n');
  process.exit(2);
}

function collectText(input) {
  if (typeof input.content === 'string') return input.content;
  if (typeof input.new_string === 'string') return input.new_string;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e?.new_string ?? '').join('\n');
  return '';
}
function ok() { process.exit(0); }
async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
main().catch(() => process.exit(0));

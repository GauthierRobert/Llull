#!/usr/bin/env node
/**
 * SessionStart primer — injects llull's invariants so every session starts aligned.
 * Concise by design (token economy). Full rules live in .claude/rules/*.
 */
const primer = [
  'llull — MCP-first 2D + 3D CAD. Read CLAUDE.md. Key invariants:',
  '1. PRIME DIRECTIVE: never mutate the document outside a command. UI and MCP both call execute(doc,name,params).',
  '2. One command in registry.ts = a UI button + MCP tool (drivable by Claude or any MCP agent), for free.',
  '3. Dependency law: ui -> core -> lib. core/ has NO react/DOM/fetch (PreToolUse-enforced).',
  '4. Commands are pure; new command needs a registration + happy/failure tests. Gate: core/commands/** 90/85/90/90.',
  '5. Tool names are snake_case. `npm run check` must be green before done.',
  'Agents: command-author, viewport-engineer, mcp-engineer, test-verifier, cad-reviewer (default to multi-agent).',
  'Skills: add-command, mcp-server, viewport-feature, verify-llull.',
].join('\n');

try {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: primer },
  }));
} catch {
  process.stdout.write(primer);
}
process.exit(0);

#!/usr/bin/env node
/**
 * claude-lint — checks that the .claude/ layer resolves: skills/agents named in CLAUDE.md exist,
 * skill/agent frontmatter `name` matches its file, path-scoped rules have a `paths:` list,
 * `.claude/…` / `docs/…` / `rules/…` / `context/…` references point to real files, and hook
 * scripts wired in settings.json exist. Pure fs reads; < 50 ms.
 * CLI: `npm run claude:lint` (exit 1 on error). Also imported by stop-gate.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns {string[]} one message per broken reference */
export function lintClaude(root = process.cwd()) {
  const errors = [];
  const claudeDir = join(root, '.claude');
  const read = (path) => readFileSync(path, 'utf8');

  const skills = readdirSync(join(claudeDir, 'skills')).filter((d) => statSync(join(claudeDir, 'skills', d)).isDirectory());
  for (const skill of skills) {
    const file = join(claudeDir, 'skills', skill, 'SKILL.md');
    if (!existsSync(file)) {
      errors.push(`skills/${skill}: missing SKILL.md`);
      continue;
    }
    const front = frontmatter(read(file));
    if (front.name !== skill) errors.push(`skills/${skill}/SKILL.md: frontmatter name "${front.name ?? ''}" != directory`);
    if (!front.description) errors.push(`skills/${skill}/SKILL.md: missing description`);
  }

  const agents = readdirSync(join(claudeDir, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  for (const agent of agents) {
    const front = frontmatter(read(join(claudeDir, 'agents', `${agent}.md`)));
    if (front.name !== agent) errors.push(`agents/${agent}.md: frontmatter name "${front.name ?? ''}" != file name`);
    if (!front.description) errors.push(`agents/${agent}.md: missing description`);
  }

  const claudeMd = read(join(root, 'CLAUDE.md'));
  const skillsSection = section(claudeMd, 'SKILLS');
  for (const [, name] of skillsSection.matchAll(/^- `([a-z0-9-]+)`/gm))
    if (!skills.includes(name)) errors.push(`CLAUDE.md SKILLS lists \`${name}\` but .claude/skills/${name}/ does not exist`);
  for (const skill of skills)
    if (!skillsSection.includes(`\`${skill}\``)) errors.push(`CLAUDE.md SKILLS does not list .claude/skills/${skill}`);
  for (const [, name] of section(claudeMd, 'AGENTS').matchAll(/^\| `([a-z0-9-]+)`/gm))
    if (!agents.includes(name)) errors.push(`CLAUDE.md AGENTS lists \`${name}\` but .claude/agents/${name}.md does not exist`);

  const rulesDir = join(claudeDir, 'rules');
  for (const rule of readdirSync(rulesDir)) {
    const text = read(join(rulesDir, rule));
    if (text.startsWith('---') && !/^paths:\s*\n(\s+- .+\n)+/m.test(text)) errors.push(`rules/${rule}: frontmatter without a paths: list`);
  }

  const docs = [join(root, 'CLAUDE.md'), ...markdownFiles(claudeDir)];
  for (const doc of docs) {
    const text = read(doc);
    const where = relative(root, doc);
    for (const [, ref] of text.matchAll(/(?:^|[\s`(@])((?:\.claude\/|docs\/|rules\/|context\/)[\w./-]+\.(?:md|mjs|json))/g)) {
      const base = ref.startsWith('rules/') || ref.startsWith('context/') ? claudeDir : root;
      if (!existsSync(join(base, ref))) errors.push(`${where}: reference to missing ${ref}`);
    }
  }

  const settings = JSON.parse(read(join(claudeDir, 'settings.json')));
  for (const groups of Object.values(settings.hooks ?? {}))
    for (const group of groups)
      for (const hook of group.hooks ?? [])
        for (const [, script] of String(hook.command ?? '').matchAll(/(\.claude\/hooks\/[\w.-]+)/g))
          if (!existsSync(join(root, script))) errors.push(`settings.json: hook script ${script} missing`);

  return errors;
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const fields = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function section(markdown, heading) {
  const start = markdown.search(new RegExp(`^## ${heading}\\b`, 'm'));
  if (start < 0) return '';
  const rest = markdown.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'work') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = lintClaude();
  if (errors.length) {
    console.error(`claude-lint: ${errors.length} problem(s)\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.warn('claude-lint: .claude/ references resolve.');
}

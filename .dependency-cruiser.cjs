/**
 * Architecture as code — the dependency laws of `.claude/rules/architecture.md` (L2, L9, L10),
 * checked by `npm run arch` (part of `npm run check`) for every change, human or agent.
 * The PreToolUse hook gives agents early feedback; this file is the authority.
 *
 * Layers (one-way): src/ui, server → src/app → packages/{mcp, domain-aec, kernel-*} → packages/core
 * Inside core:      commands, codegen, plugins → geometry → model → lib
 */

/** Runtime edges only: `import type` is erased at build time and may follow recursive data. */
const RUNTIME = { dependencyTypesNot: ['type-only'] };

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment:
        'A runtime import cycle makes module init order matter and hides layering. Break it by ' +
        'moving the shared piece down a layer (see commands/commandTable.ts for the pattern).',
      severity: 'error',
      from: {},
      to: { ...RUNTIME, circular: true, viaOnly: RUNTIME },
    },
    {
      name: 'core-imports-no-package',
      comment: 'L2/L10: packages/core is the bottom layer; plugins, kernels and mcp depend on it.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^(packages/(?!core/)|src/|server/)' },
    },
    {
      name: 'packages-import-no-app',
      comment: 'L2: no package imports the web app (src/) or the server.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^(src|server)/' },
    },
    {
      name: 'packages-are-headless',
      comment: 'L2: packages run in Node and the browser alike — no React, three.js or UI state.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: 'node_modules/(react|react-dom|@react-three|three|three-stdlib|zustand)/' },
    },
    {
      name: 'plugins-and-kernels-depend-on-core-only',
      comment: 'L9/L10: a domain plugin or a kernel reaches the app only through core contracts.',
      severity: 'error',
      from: { path: '^packages/(domain-[^/]+|kernel-[^/]+)/' },
      to: { path: '^packages/(?!core/)', pathNot: '^packages/$1/' },
    },
    {
      name: 'plugins-use-the-core-public-api',
      comment:
        'L10: plugins and kernels see core through its published surface — model, lib, geometry, ' +
        'the plugin contract and the command-authoring API (schema, types, noop, derivation, ' +
        'registry). Composing another command goes through `execute`, never its module.',
      severity: 'error',
      from: { path: '^packages/(domain-[^/]+|kernel-[^/]+)/' },
      to: {
        path: '^packages/core/src/',
        pathNot:
          '^packages/core/src/(model|lib|geometry)/|' +
          '^packages/core/src/plugins/plugin\\.ts$|' +
          '^packages/core/src/commands/(schema|types|noop|derivation|registry)\\.ts$',
      },
    },
    {
      name: 'mcp-is-a-view-of-the-registry',
      comment: 'L5: MCP exposes the registry; it never depends on a plugin or a concrete kernel.',
      severity: 'error',
      from: { path: '^packages/mcp/' },
      to: { path: '^packages/(domain-|kernel-)' },
    },
    {
      name: 'lib-is-a-leaf',
      comment: '@lib holds tiny pure helpers; it depends on nothing else in the repo.',
      severity: 'error',
      from: { path: '^packages/core/src/lib/' },
      to: { ...RUNTIME, path: '^packages/', pathNot: '^packages/core/src/lib/' },
    },
    {
      name: 'model-below-commands',
      comment: 'The model is data; it never reaches up into commands, codegen or plugins.',
      severity: 'error',
      from: { path: '^packages/core/src/(model|geometry)/' },
      to: { ...RUNTIME, path: '^packages/core/src/(commands|codegen|plugins)/' },
    },
    {
      name: 'server-is-thin',
      comment: 'L6: the server hosts /mcp and the live document; it never imports the React app.',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^src/ui/' },
    },
    {
      name: 'ui-does-not-import-server',
      comment: 'L6: the backend is optional; the web app talks to it over HTTP, never by import.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^server/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'server/ installs its own npm dependencies (not a workspace); its aliases still resolve.',
      severity: 'error',
      from: { pathNot: '^server/' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/|\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs'],
    },
  },
};

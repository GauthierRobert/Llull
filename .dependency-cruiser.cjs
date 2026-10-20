/**
 * Architecture as code — the dependency laws of `.claude/rules/architecture.md` (L2, L9, L10),
 * checked by `npm run arch` (part of `npm run check`) for every change, human or agent.
 * The PreToolUse hook gives agents early feedback; this file is the authority.
 *
 * Layers (one-way): desktop → server; src/ui, server → src/app → packages/{protocol, domain-aec, domain-cae, domain-aero, design-lang, plm, kernel-*, physics-*} → packages/core
 * Inside core:      commands, codegen, plugins → dynamics → geometry → model → lib
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cycles',
      comment:
        'An import cycle (type-only included) makes init order matter and hides layering. Break ' +
        'it by moving the shared piece down a layer (commands/commandTable.ts, model/vectors.ts ' +
        'show the pattern); mutually recursive types belong in one module.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-imports-no-package',
      comment: 'L2/L10: packages/core is the bottom layer; plugins, kernels and the protocol package depend on it.',
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
      comment: 'L9/L10: a domain plugin, a geometry kernel or a physics engine reaches the app only through core contracts.',
      severity: 'error',
      from: { path: '^packages/(domain-[^/]+|kernel-[^/]+|physics-[^/]+|design-lang|plm)/' },
      to: { path: '^packages/(?!core/)', pathNot: '^packages/$1/' },
    },
    {
      name: 'plugins-use-the-core-public-api',
      comment:
        'L10: plugins and kernels see core through its published surface — model, lib, geometry, ' +
        'the plugin contract and the command-authoring API (schema, types, noop, derivation, ' +
        'registry). Composing another command goes through `execute`, never its module.',
      severity: 'error',
      from: { path: '^packages/(domain-[^/]+|kernel-[^/]+|physics-[^/]+|design-lang|plm)/' },
      to: {
        path: '^packages/core/src/',
        pathNot:
          '^packages/core/src/(model|lib|geometry)/|' +
          '^packages/core/src/dynamics/physicsEngine\\.ts$|' +
          '^packages/core/src/plugins/plugin\\.ts$|' +
          '^packages/core/src/commands/(schema|types|noop|derivation|registry)\\.ts$',
      },
    },
    {
      name: 'design-lang-is-removable',
      comment:
        'The .lld design language is a removable layer: only the composition root installs it, nothing else may depend on it ' +
        '(docs/DESIGN_LANGUAGE.md §2).',
      severity: 'error',
      from: { path: '^(packages|src|server)/', pathNot: '^(packages/design-lang/|src/app/plugins\.ts$)' },
      to: { path: '^packages/design-lang/' },
    },
    {
      name: 'protocol-is-a-view-of-the-registry',
      comment:
        'L5: the host protocol (CLI tools, live sync) exposes the registry; it never depends on a plugin, a concrete kernel or a physics engine.',
      severity: 'error',
      from: { path: '^packages/protocol/' },
      to: { path: '^packages/(domain-|kernel-|physics-)' },
    },
    {
      name: 'lib-is-a-leaf',
      comment: '@lib holds tiny pure helpers; it depends on nothing but the vector types.',
      severity: 'error',
      from: { path: '^packages/core/src/lib/' },
      to: { path: '^packages/', pathNot: '^packages/core/src/(lib/|model/vectors\\.ts$)' },
    },
    {
      name: 'model-is-the-data-layer',
      comment: 'The model is data: it depends only on itself and lib, even for types.',
      severity: 'error',
      from: { path: '^packages/core/src/model/' },
      to: { path: '^packages/core/src/(?!model/|lib/)' },
    },
    {
      name: 'dynamics-below-commands',
      comment: 'Dynamics (physics-engine contract, simulation model, force laws) never reaches up into commands.',
      severity: 'error',
      from: { path: '^packages/core/src/dynamics/' },
      to: { path: '^packages/core/src/(commands|codegen|plugins)/' },
    },
    {
      name: 'geometry-below-commands',
      comment: 'Geometry (kernel contract, recipes, pure geometry) never reaches up into commands.',
      severity: 'error',
      from: { path: '^packages/core/src/geometry/' },
      to: { path: '^packages/core/src/(commands|codegen|plugins|dynamics)/' },
    },
    {
      name: 'server-is-thin',
      comment: 'L6: the server hosts the live document and the CLI; it never imports the React app.',
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
      name: 'nothing-imports-desktop',
      comment: 'KI6: desktop/ is the outermost host (Electron shell); no package, app or server code depends on it.',
      severity: 'error',
      from: { path: '^(packages|src|server)/' },
      to: { path: '^desktop/' },
    },
    {
      name: 'desktop-is-a-host',
      comment: 'L6/KI6: the desktop shell starts the server and loads the web app over HTTP; it never imports the UI.',
      severity: 'error',
      from: { path: '^desktop/' },
      to: { path: '^src/' },
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

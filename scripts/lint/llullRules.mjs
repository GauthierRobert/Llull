/**
 * Repo-specific lint rules, loaded by oxlint as an ESLint-compatible JS plugin (`.oxlintrc.json` `jsPlugins`).
 * - `no-import-meta`: server/ and desktop/ ship as CommonJS bundles (esbuild --format=cjs) but type-check with bundler resolution,
 *   so tsc does not flag ESM-only `import.meta`.
 */
const noImportMeta = {
  meta: { type: 'problem', docs: { description: 'Disallow import.meta in CommonJS-bundled sources' } },
  create(context) {
    return {
      MetaProperty(node) {
        if (node.meta.name === 'import')
          context.report({ node, message: 'import.meta does not exist in the CommonJS server/desktop bundles.' });
      },
    };
  },
};

export default { meta: { name: 'llull' }, rules: { 'no-import-meta': noImportMeta } };

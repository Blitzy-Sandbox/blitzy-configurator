/**
 * Backend workspace ESLint configuration.
 *
 * Extends the root .eslintrc.json and adds parserOptions.project so that
 * @typescript-eslint type-aware rules (e.g. @typescript-eslint/no-floating-promises)
 * can resolve parserServices against the backend tsconfig.
 *
 * `__dirname` ensures the tsconfig is resolved relative to this config file
 * regardless of which cwd ESLint is invoked from (npm workspace, root, CI).
 */
module.exports = {
  extends: '../.eslintrc.json',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
};

/**
 * ESLint flat config (ESLint 9). Deliberately dependency-light: no plugin bundles,
 * just correctness rules plus explicit globals for the two runtimes we target
 * (browser for `public/`, Node for `scripts/`).
 */

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  Node: 'readonly',
  location: 'readonly',
  history: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  EventSource: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  MediaMetadata: 'readonly',
  Audio: 'readonly',
  ResizeObserver: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
};

const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  __dirname: 'readonly',
};

const rules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': 'warn',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  eqeqeq: ['warn', 'smart'],
  'prefer-const': 'warn',
  'object-shorthand': 'warn',
};

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'media/**', 'public/assets/fonts/**', 'public/assets/img/**'],
  },
  {
    files: ['public/assets/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browserGlobals },
    rules,
  },
  {
    files: ['scripts/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules,
  },
];

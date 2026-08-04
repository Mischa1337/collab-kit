module.exports = {
  // TypeScript-Parser statt Standard-JS-Parser — versteht Typen und Generics
  parser: '@typescript-eslint/parser',

  // Aktiviert typescript-eslint Regeln als Plugin
  plugins: ['@typescript-eslint'],

  extends: [
    // Basis: ESLints empfohlene JS-Regeln (no-unused-vars, no-undef, …)
    'eslint:recommended',
    // TypeScript-spezifische Regeln (any-Verwendung, Typ-Assertions, …)
    'plugin:@typescript-eslint/recommended',
    // Schaltet alle ESLint-Regeln ab, die mit Prettier kollidieren würden
    'prettier',
  ],

  env: {
    // Globale Node.js-Variablen erlauben (process, __dirname, require, …)
    node: true,
    // Moderne JS-Syntax (optional chaining, nullish coalescing, …)
    es2020: true,
  },

  rules: {
    // Unbenutzte Variablen sind ein Fehler — Ausnahme: Parameter die mit _ beginnen
    // (z.B. (_req, res) in Express-Handlern wo req nicht gebraucht wird)
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // Rückgabetypen müssen nicht explizit annotiert werden — TypeScript inferiert sie
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
};

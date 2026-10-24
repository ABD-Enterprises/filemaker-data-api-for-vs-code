import js from "@eslint/js";
import tsplugin from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.vitest.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      "@typescript-eslint": tsplugin,
    },
    rules: {
      ...tsplugin.configs.recommended.rules,
      // TypeScript already verifies undefined names; eslint:recommended's
      // no-undef is redundant and produces false positives for ambient
      // type names (NodeJS namespace, vitest hook globals, etc.).
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/webviews/*/ui/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      // Local status elements can shadow the legacy window.status property.
      globals: { ...globals.browser, ...globals.es2022, status: "off", acquireVsCodeApi: "readonly", FieldStandards: "readonly" },
    },
  },
  {
    // These pure browser helpers also support CommonJS for unit tests.
    files: ["src/webviews/queryBuilder/ui/findForm.js", "src/webviews/queryBuilder/ui/cellText.js"],
    languageOptions: { globals: { module: "readonly" } },
  },
  {
    // Node scripts: the mock server and the real-VS-Code UI tests.
    files: ["test/mock-server/**/*.mjs", "e2e-ui/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-irregular-whitespace": "off", // the tests send U+2028/2029 on purpose
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // These functions are serialised and run inside a browser page.
    files: ["e2e-ui/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser } },
    rules: { "no-unused-vars": "off" }, // journeys keep exploratory values for the failure detail
  },
  prettier,
];

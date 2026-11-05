import js from "./scripts/lint/node_modules/@eslint/js/src/index.js";
import ts from "./scripts/lint/node_modules/typescript-eslint/dist/index.js";
import globals from "./scripts/lint/node_modules/globals/index.js";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/.runtime/**",
      "tests/artifacts/**",
      "tests/atmosphere/skills/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: ts.parser },
    plugins: { "@typescript-eslint": ts.plugin },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true },
      ],
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
    },
  },
];

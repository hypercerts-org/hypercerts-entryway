import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
import svelte from "eslint-plugin-svelte";

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
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: { parser: ts.parser },
      globals: { ...globals.node, ...globals.browser },
    },
  },
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

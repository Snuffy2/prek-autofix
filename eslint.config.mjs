// @ts-check

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["packages/collect/src/git.ts"],
    rules: {
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["packages/shared/src/artifact.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  {
    files: ["tests/docs/action-metadata.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettier,
]);

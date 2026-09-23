import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const localRulesPlugin = {
  rules: {
    "no-empty-catch": {
      meta: {
        type: "problem",
        docs: {
          description: "Forbid empty catch blocks, including those only containing comments",
        },
        schema: [],
        messages: {
          noEmptyCatch: "Empty catch block is not allowed. All catches must log or handle the error.",
        },
      },
      create(context) {
        return {
          CatchClause(node) {
            if (node.body.body.length === 0) {
              context.report({
                node,
                messageId: "noEmptyCatch",
              });
            }
          },
        };
      },
    },
  },
};

export default defineConfig(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "vendor/**",
      "tests/pass/**",
      "tests/fail/**"
    ],
  },
  {
    plugins: {
      local: localRulesPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ],
      "no-empty": ["error", { "allowEmptyCatch": false }],
      "local/no-empty-catch": "error"
    }
  }
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/cdk.out/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Raw tenant-unscoped access must go through @mm/db's withTenant/system helpers.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "Use @mm/db (tenant-scoped client) instead of pg directly." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/db/**", "infra/**", "**/test/**"],
    rules: { "no-restricted-imports": "off" },
  },
);

import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: { testTimeout: 120_000, exclude: [...configDefaults.exclude, "cdk.out/**"] },
});

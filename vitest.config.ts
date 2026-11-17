import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary"],
      // CI fails if coverage drops below these.
      thresholds: { statements: 92, branches: 82, functions: 92, lines: 94 },
    },
  },
});

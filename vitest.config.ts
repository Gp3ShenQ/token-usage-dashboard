import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["server/monitor/__tests__/*.spec.ts", "src/widget/__tests__/*.spec.ts", "scripts/__tests__/*.spec.mjs"] },
});

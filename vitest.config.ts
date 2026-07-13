import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Modules import `serverEnv`/`publicEnv`, which require these at load time.
    // These are throwaway test values — never used to hit a real service.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      LIVEKIT_API_KEY: "test-livekit-key",
      LIVEKIT_API_SECRET: "test-livekit-secret",
      KHALTI_SECRET_KEY: "test-khalti-secret",
      ESEWA_SECRET_KEY: "test-esewa-secret",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Tests run inside the real workerd runtime with local (Miniflare) D1 and R2.
// Nothing touches Cloudflare: remote bindings are disabled.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("./migrations");
      return {
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            ENVIRONMENT: "development",
            GITHUB_OAUTH_CLIENT_ID: "Iv1.test-client-id",
            GITHUB_BOT_LOGIN: "cyw-bot",
            MAINTAINER_LOGINS: "boss-maintainer",
            GITHUB_TOKEN: "test-github-token-SECRET",
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
  },
});

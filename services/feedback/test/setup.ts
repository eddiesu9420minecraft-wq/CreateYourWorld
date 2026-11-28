// Applies the D1 migrations to the local (Miniflare) database before the tests run.
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach } from "vitest";
import { setGitHubFetch } from "../src/github";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

afterEach(() => {
  setGitHubFetch(null);
});

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Each test file gets isolated storage; make sure the schema exists first.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

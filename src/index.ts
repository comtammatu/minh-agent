import { log } from "./lib/logger.js";
import { runRuntime } from "./runtime/app.js";

runRuntime().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("lifecycle", `EXIT | ${msg}`);
  process.exit(1);
});

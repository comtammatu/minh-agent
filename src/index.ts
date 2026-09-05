import { boot } from "./app/boot.js";
import { log } from "./lib/logger.js";

boot().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("lifecycle", `EXIT | ${msg}`);
  process.exit(1);
});

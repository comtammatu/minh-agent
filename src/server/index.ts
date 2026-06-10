import type { Server } from "bun";
import { assertDashboardBindingAllowed, DASHBOARD } from "../config.js";
import { log } from "../lib/logger.js";
import type { DashboardServerState } from "./contracts.js";
import { createDashboardFetchHandler } from "./handlers.js";

let dashboardServer: Server<undefined> | null = null;

export function startDashboardServer(state: DashboardServerState): void {
  if (dashboardServer !== null) return;
  assertDashboardBindingAllowed(DASHBOARD.host);

  dashboardServer = Bun.serve({
    hostname: DASHBOARD.host,
    port: DASHBOARD.port,
    fetch: createDashboardFetchHandler({ state }),
  });

  log.info(
    "dashboard",
    `Dashboard listening on http://${DASHBOARD.host}:${DASHBOARD.port}/dashboard/`,
  );
}

export function stopDashboardServer(): void {
  if (dashboardServer === null) return;
  dashboardServer.stop(true);
  dashboardServer = null;
  log.info("dashboard", "Dashboard server stopped");
}

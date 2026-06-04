import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIBRARY_ROOT =
  "/Users/luongthebinh/Downloads/Personal/charting_library-29.4.0";

function repoRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function getSourceRoot(): string {
  return process.env.TRADINGVIEW_LIBRARY_PATH?.trim() || DEFAULT_LIBRARY_ROOT;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const root = repoRoot();
  const sourceRoot = getSourceRoot();
  const chartingSource = path.join(sourceRoot, "charting_library");
  const datafeedsSource = path.join(sourceRoot, "datafeeds");
  const chartingTarget = path.join(
    root,
    "dashboard",
    "public",
    "charting_library",
  );
  const datafeedsTarget = path.join(root, "dashboard", "public", "datafeeds");

  const sourceReady =
    (await pathExists(chartingSource)) && (await pathExists(datafeedsSource));
  if (!sourceReady) {
    const targetReady =
      (await pathExists(chartingTarget)) && (await pathExists(datafeedsTarget));
    if (targetReady) {
      console.log(
        `TradingView assets already present in dashboard/public; source path missing: ${sourceRoot}`,
      );
      return;
    }
    throw new Error(
      `TradingView assets not found. Set TRADINGVIEW_LIBRARY_PATH or place assets at ${DEFAULT_LIBRARY_ROOT}`,
    );
  }

  await syncDirectory(chartingSource, chartingTarget);
  await syncDirectory(datafeedsSource, datafeedsTarget);

  console.log(`TradingView assets synced from ${sourceRoot}`);
}

await main();

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

export type SpeedMode = "max" | "default";

export function isSpeedMode(value: string): value is SpeedMode {
  return value === "max" || value === "default";
}

export async function setSpeedMode(mode: SpeedMode): Promise<void> {
  const file = config.SPEED_MODE_FILE;
  if (!file) {
    throw new Error("TELESEERR_SPEED_MODE_FILE is not configured");
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${mode}\n`, "utf8");
  log.info({ mode }, "qBittorrent speed mode override changed");
}

export async function getSpeedMode(): Promise<SpeedMode | "unknown"> {
  const file = config.SPEED_MODE_FILE;
  if (!file) return "unknown";

  try {
    const value = (await readFile(file, "utf8")).trim().toLowerCase();
    return isSpeedMode(value) ? value : "unknown";
  } catch {
    return "default";
  }
}

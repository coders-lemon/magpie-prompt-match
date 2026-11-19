import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginOptions } from "./core/types.ts";

export const DEFAULT_UI_PORT = 47831;

export function expandHome(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function getMagpieConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAGPIE_CONFIG_DIR) {
    return expandHome(env.MAGPIE_CONFIG_DIR);
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(expandHome(env.XDG_CONFIG_HOME), "magpie");
  }
  return path.join(os.homedir(), ".config", "magpie");
}

export function getSettingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getMagpieConfigDir(env), "prompt-match.json");
}

export function getDefaultOptions(env: NodeJS.ProcessEnv = process.env): PluginOptions {
  return {
    enabled: true,
    promptsDir: path.join(getMagpieConfigDir(env), "prompts"),
    extraInstructionFiles: ["CLAUDE.md"],
    skipUtilityRequests: true,
    uiPort: DEFAULT_UI_PORT,
    debug: false,
  };
}

let cachedFileSettings: { mtimeMs: number; data: Partial<PluginOptions> } | null = null;

export function loadPersistedSettings(
  env: NodeJS.ProcessEnv = process.env
): Partial<PluginOptions> {
  const filePath = getSettingsFilePath(env);
  try {
    const stat = fs.statSync(filePath);
    if (cachedFileSettings && cachedFileSettings.mtimeMs === stat.mtimeMs) {
      return cachedFileSettings.data;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginOptions>;
    if (!parsed || typeof parsed !== "object") return {};
    cachedFileSettings = { mtimeMs: stat.mtimeMs, data: parsed };
    return parsed;
  } catch {
    return {};
  }
}

export function savePersistedSettings(
  patch: Partial<PluginOptions>,
  env: NodeJS.ProcessEnv = process.env
): PluginOptions {
  const filePath = getSettingsFilePath(env);
  const current = { ...getDefaultOptions(env), ...loadPersistedSettings(env) };
  const merged = mergeOptions(current, patch);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  cachedFileSettings = null;
  return merged;
}

export function mergeOptions(
  base: PluginOptions,
  override?: Partial<PluginOptions> | Record<string, unknown>
): PluginOptions {
  if (!override || typeof override !== "object") {
    return { ...base, promptsDir: expandHome(base.promptsDir) };
  }

  const next: PluginOptions = { ...base };

  if (typeof override.enabled === "boolean") {
    next.enabled = override.enabled;
  }
  if (typeof override.promptsDir === "string" && override.promptsDir.trim()) {
    next.promptsDir = expandHome(override.promptsDir.trim());
  }
  if (Array.isArray(override.extraInstructionFiles)) {
    next.extraInstructionFiles = override.extraInstructionFiles
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
  }
  if (typeof override.skipUtilityRequests === "boolean") {
    next.skipUtilityRequests = override.skipUtilityRequests;
  }
  if (override.uiPort !== undefined) {
    const port = Number(override.uiPort);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      next.uiPort = port;
    }
  }
  if (typeof override.debug === "boolean") {
    next.debug = override.debug;
  }

  next.promptsDir = expandHome(next.promptsDir);
  return next;
}

export function resolveEffectiveOptions(
  ctxOptions?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): PluginOptions {
  const defaults = getDefaultOptions(env);
  const persisted = loadPersistedSettings(env);
  return mergeOptions(mergeOptions(defaults, persisted), ctxOptions);
}

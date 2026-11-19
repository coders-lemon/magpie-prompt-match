import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HitLogStore } from "./hit-log.ts";
import { getMagpieConfigDir } from "./settings.ts";

export interface CatalogModel {
  /** Full identifier, e.g. "openai/gpt-6.2" or "group/coding". */
  id: string;
  /** Provider ID, e.g. "openai", "workbuddy", "antigravity-bridge", or "group". */
  provider: string;
  /** Bare model ID without provider prefix, e.g. "gpt-6.2". */
  model: string;
  /** Optional display label. */
  label?: string;
  /** True for Magpie routing groups. */
  isGroup: boolean;
  /** Where this model entry was discovered. */
  source: "gateway" | "cli" | "config" | "logs";
}

export interface ModelCatalogSnapshot {
  models: CatalogModel[];
  providers: string[];
  groups: string[];
  sources: string[];
  fetchedAt: string;
}

const CACHE_TTL_MS = 30_000;
let cachedCatalog: { expiresAt: number; key: string; snapshot: ModelCatalogSnapshot } | null =
  null;

export function clearModelCatalogCache(): void {
  cachedCatalog = null;
}

function normalizeModelId(rawId: string): { id: string; provider: string; model: string; isGroup: boolean } | null {
  let fullId = rawId.trim();
  if (!fullId || /^https?:\/\//i.test(fullId)) return null;
  if (fullId.startsWith("magpie/group/")) {
    fullId = fullId.slice("magpie/".length);
  }
  const slashIdx = fullId.indexOf("/");
  if (slashIdx <= 0 || slashIdx === fullId.length - 1) return null;
  const provider = fullId.slice(0, slashIdx).trim();
  const model = fullId.slice(slashIdx + 1).trim();
  if (!provider || !model) return null;
  return {
    id: `${provider}/${model}`,
    provider,
    model,
    isGroup: provider === "group",
  };
}

/**
 * Parse lines emitted by `magpie models` CLI.
 * Example lines:
 *   group/deeepseek-flash                 deeepseek-flash  low/high
 *   codex/gpt-6-luna                      GPT-6-Luna  low/medium/high/xhigh/max
 *   antigravity-bridge/gemini-4-hydrogen  Gemini 4 Hydrogen  low/medium/high/xhigh
 *   http://127.0.0.1:3425/v1
 */
export function parseMagpieModelsCliOutput(stdout: string): CatalogModel[] {
  const results: CatalogModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.startsWith("magpie:") ||
      line.startsWith("no models") ||
      line.startsWith("usage:") ||
      /^https?:\/\//i.test(line)
    ) {
      continue;
    }

    const tokenMatch = line.match(
      /^([A-Za-z0-9._-]+\/[A-Za-z0-9._:+-]+)(?:\s+(.*))?$/
    );
    if (!tokenMatch) continue;

    const norm = normalizeModelId(tokenMatch[1]);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);

    const rest = (tokenMatch[2] || "").trim();
    const firstCol = rest ? rest.split(/\s{2,}|·/)[0].trim() : undefined;
    const label =
      firstCol && firstCol !== norm.id && firstCol !== norm.model
        ? firstCol
        : undefined;

    results.push({
      ...norm,
      label,
      source: "cli",
    });
  }

  return results;
}

/**
 * Parse OpenAI-compatible `/v1/models` JSON response from Magpie's running local gateway.
 */
export function parseGatewayModelsPayload(payload: unknown): CatalogModel[] {
  if (!payload || typeof payload !== "object") return [];
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];

  const results: CatalogModel[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { id?: unknown; name?: unknown; owned_by?: unknown };
    if (typeof rec.id !== "string") continue;

    let candidateId = rec.id.trim();
    if (!candidateId.includes("/") && typeof rec.owned_by === "string" && rec.owned_by.trim()) {
      candidateId = `${rec.owned_by.trim()}/${candidateId}`;
    }

    const norm = normalizeModelId(candidateId);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);

    const rawName = typeof rec.name === "string" ? rec.name.trim() : undefined;
    const label =
      rawName && rawName !== norm.id && rawName !== norm.model ? rawName : undefined;

    results.push({
      ...norm,
      label,
      source: "gateway",
    });
  }

  return results;
}

function resolveGatewayBaseUrl(configDir: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = (env.MAGPIE_ADDR || "").trim();
  if (fromEnv) {
    return /^https?:\/\//i.test(fromEnv) ? fromEnv.replace(/\/+$/, "") : `http://${fromEnv}`;
  }

  try {
    const gwPath = path.join(configDir, "gateway.json");
    if (fs.existsSync(gwPath)) {
      const parsed = JSON.parse(fs.readFileSync(gwPath, "utf8")) as Record<string, unknown>;
      const urlVal = typeof parsed.url === "string" ? parsed.url.trim() : "";
      if (urlVal) return urlVal.replace(/\/+$/, "");

      const addrVal =
        (typeof parsed.addr === "string" && parsed.addr.trim()) ||
        (typeof parsed.listen === "string" && parsed.listen.trim()) ||
        "";
      if (addrVal) {
        const normalized = addrVal.startsWith(":")
          ? `127.0.0.1${addrVal}`
          : addrVal.replace(/^0\.0\.0\.0:/, "127.0.0.1:");
        return /^https?:\/\//i.test(normalized)
          ? normalized.replace(/\/+$/, "")
          : `http://${normalized}`;
      }

      const port = Number(parsed.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        const host =
          typeof parsed.host === "string" && parsed.host.trim() && parsed.host !== "0.0.0.0"
            ? parsed.host.trim()
            : "127.0.0.1";
        return `http://${host}:${port}`;
      }
    }
  } catch {
    // Fall back to Magpie's default local gateway port
  }

  return "http://127.0.0.1:3425";
}

async function fetchModelsFromGateway(
  configDir: string,
  env: NodeJS.ProcessEnv,
  gatewayUrlOverride?: string,
  timeoutMs = 1500
): Promise<CatalogModel[]> {
  const baseUrl = (gatewayUrlOverride || resolveGatewayBaseUrl(configDir, env)).replace(
    /\/+$/,
    ""
  );
  const endpoints = [`${baseUrl}/v1/models`, `${baseUrl}/models`];

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const parsed = parseGatewayModelsPayload(json);
      if (parsed.length > 0) return parsed;
    } catch {
      // Gateway may not be running or unreachable; try next source
    } finally {
      clearTimeout(timer);
    }
  }

  return [];
}

function resolveMagpieBinary(env: NodeJS.ProcessEnv): string {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "magpie"),
    "/usr/local/bin/magpie",
    "/usr/bin/magpie",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return env.MAGPIE_BIN || "magpie";
}

function runMagpieModelsCli(
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000
): Promise<CatalogModel[]> {
  return new Promise((resolve) => {
    try {
      const bin = resolveMagpieBinary(env);
      const child = execFile(
        bin,
        ["models"],
        { env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          resolve(parseMagpieModelsCliOutput(stdout));
        }
      );
      child.unref?.();
    } catch {
      resolve([]);
    }
  });
}

function extractModelsFromList(
  providerId: string,
  rawModels: unknown,
  out: CatalogModel[],
  seen: Set<string>
): void {
  const pushModel = (modelId: string, label?: string) => {
    const cleanModel = modelId.trim();
    if (!cleanModel) return;
    const candidate = cleanModel.includes("/")
      ? cleanModel
      : `${providerId}/${cleanModel}`;
    const norm = normalizeModelId(candidate);
    if (!norm || seen.has(norm.id)) return;
    seen.add(norm.id);
    out.push({
      ...norm,
      label: label && label !== norm.model && label !== norm.id ? label : undefined,
      source: "config",
    });
  };

  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      if (typeof item === "string") {
        pushModel(item);
      } else if (item && typeof item === "object") {
        const rec = item as { id?: unknown; model?: unknown; name?: unknown };
        const id =
          typeof rec.id === "string"
            ? rec.id
            : typeof rec.model === "string"
              ? rec.model
              : "";
        const label = typeof rec.name === "string" ? rec.name : undefined;
        if (id) pushModel(id, label);
      }
    }
  } else if (rawModels && typeof rawModels === "object") {
    for (const [key, val] of Object.entries(rawModels as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const rec = val as { id?: unknown; name?: unknown };
        const id = typeof rec.id === "string" ? rec.id : key;
        const label = typeof rec.name === "string" ? rec.name : undefined;
        pushModel(id, label);
      } else {
        pushModel(key);
      }
    }
  }
}

function extractProvidersContainer(
  data: unknown,
  out: CatalogModel[],
  seen: Set<string>
): void {
  if (!data || typeof data !== "object") return;

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const rec = item as {
        id?: unknown;
        provider?: unknown;
        name?: unknown;
        models?: unknown;
        picked?: unknown;
      };
      const pid =
        (typeof rec.id === "string" && rec.id.trim()) ||
        (typeof rec.provider === "string" && rec.provider.trim()) ||
        "";
      if (pid && rec.models !== undefined) {
        extractModelsFromList(pid, rec.models, out, seen);
      }
      if (pid && rec.picked !== undefined) {
        extractModelsFromList(pid, rec.picked, out, seen);
      }
    }
    return;
  }

  const obj = data as Record<string, unknown>;
  if (obj.providers !== undefined) {
    extractProvidersContainer(obj.providers, out, seen);
    return;
  }

  for (const [key, val] of Object.entries(obj)) {
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      extractProvidersContainer(val, out, seen);
      continue;
    }
    const rec = val as {
      id?: unknown;
      models?: unknown;
      picked?: unknown;
      providers?: unknown;
    };
    if (rec.providers !== undefined) {
      extractProvidersContainer(rec.providers, out, seen);
    } else {
      const pid = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : key;
      if (rec.models !== undefined) {
        extractModelsFromList(pid, rec.models, out, seen);
      }
      if (rec.picked !== undefined) {
        extractModelsFromList(pid, rec.picked, out, seen);
      }
    }
  }
}

function extractGroupsFromSettings(
  data: unknown,
  out: CatalogModel[],
  seen: Set<string>
): void {
  if (!data || typeof data !== "object") return;
  const obj = data as Record<string, unknown>;
  const rawGroups = obj.groups ?? obj.routingGroups ?? obj.routing_groups;
  if (!rawGroups) return;

  const pushGroup = (id: string, label?: string) => {
    const clean = id.trim().replace(/^(?:magpie\/)?group\//, "");
    if (!clean) return;
    const fullId = `group/${clean}`;
    if (seen.has(fullId)) return;
    seen.add(fullId);
    out.push({
      id: fullId,
      provider: "group",
      model: clean,
      label: label && label !== clean ? label : undefined,
      isGroup: true,
      source: "config",
    });
  };

  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (typeof g === "string") {
        pushGroup(g);
      } else if (g && typeof g === "object") {
        const rec = g as { id?: unknown; name?: unknown };
        const id =
          (typeof rec.id === "string" && rec.id) ||
          (typeof rec.name === "string" && rec.name) ||
          "";
        if (id) pushGroup(id, typeof rec.name === "string" ? rec.name : undefined);
      }
    }
  } else if (typeof rawGroups === "object") {
    for (const [k, v] of Object.entries(rawGroups as Record<string, unknown>)) {
      const label =
        v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string"
          ? (v as { name: string }).name
          : undefined;
      pushGroup(k, label);
    }
  }
}

/**
 * Safely read ONLY provider IDs, model IDs, and routing group names from Magpie's
 * local config JSON files (never reads or exposes keys/tokens/credentials).
 */
export function loadModelsFromMagpieConfigDir(configDir: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();

  for (const fileName of ["providers.json", "plugin-providers.json"]) {
    const filePath = path.join(configDir, fileName);
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      extractProvidersContainer(parsed, out, seen);
    } catch {
      // Ignore unreadable/missing files cleanly
    }
  }

  try {
    const settingsPath = path.join(configDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      extractGroupsFromSettings(parsed, out, seen);
    }
  } catch {
    // Ignore
  }

  return out;
}

function loadModelsFromHitLogs(logs?: HitLogStore): CatalogModel[] {
  if (!logs) return [];
  const out: CatalogModel[] = [];
  const seen = new Set<string>();

  for (const entry of logs.list(200)) {
    const candidates = [entry.resolvedModel, entry.requestedModel].filter(
      (m): m is string => Boolean(m && m.trim() && !m.startsWith("("))
    );
    for (let raw of candidates) {
      raw = raw.trim();
      const candidate = raw.includes("/")
        ? raw
        : `${entry.provider || "observed"}/${raw}`;
      const norm = normalizeModelId(candidate);
      if (!norm || seen.has(norm.id)) continue;
      seen.add(norm.id);
      out.push({
        ...norm,
        source: "logs",
      });
    }
  }

  return out;
}

export interface LoadModelCatalogOptions {
  env?: NodeJS.ProcessEnv;
  logs?: HitLogStore;
  forceRefresh?: boolean;
  skipCli?: boolean;
  skipGateway?: boolean;
  gatewayUrl?: string;
}

/**
 * Load unified Magpie model catalog by merging:
 * 1. Live Magpie local gateway `/v1/models` (instant, authoritative)
 * 2. Magpie config JSONs (`providers.json`, `plugin-providers.json`, `settings.json` groups)
 * 3. `magpie models` CLI output (fallback when gateway & config returned empty)
 * 4. Recently observed models from Hit Logs
 */
export async function loadMagpieModelCatalog(
  opts: LoadModelCatalogOptions = {}
): Promise<ModelCatalogSnapshot> {
  const env = opts.env ?? process.env;
  const configDir = getMagpieConfigDir(env);
  const cacheKey = `${configDir}|${opts.skipCli ? "nocli" : "cli"}|${opts.skipGateway ? "nogw" : opts.gatewayUrl || "gw"}`;

  if (
    !opts.forceRefresh &&
    cachedCatalog &&
    cachedCatalog.key === cacheKey &&
    Date.now() < cachedCatalog.expiresAt
  ) {
    return cachedCatalog.snapshot;
  }

  const byId = new Map<string, CatalogModel>();
  const sourceSet = new Set<string>();

  const addAll = (items: CatalogModel[]) => {
    for (const item of items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
        sourceSet.add(item.source);
      } else if (!byId.get(item.id)!.label && item.label) {
        byId.get(item.id)!.label = item.label;
      }
    }
  };

  // 1. Live local gateway /v1/models (fastest, avoids spawning nested plugin host)
  if (!opts.skipGateway) {
    const gwModels = await fetchModelsFromGateway(configDir, env, opts.gatewayUrl);
    addAll(gwModels);
  }

  // 2. Local config files (adds plugin-providers + routing groups even if not exposed on /v1/models)
  const configModels = loadModelsFromMagpieConfigDir(configDir);
  addAll(configModels);

  // 3. CLI fallback only when neither gateway nor config files produced models
  if (!opts.skipCli && byId.size === 0) {
    const cliModels = await runMagpieModelsCli(env);
    addAll(cliModels);
  }

  // 4. Observed models from hit logs
  const logModels = loadModelsFromHitLogs(opts.logs);
  addAll(logModels);

  const models = Array.from(byId.values()).sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? 1 : -1;
    const pCmp = a.provider.localeCompare(b.provider);
    if (pCmp !== 0) return pCmp;
    return a.model.localeCompare(b.model);
  });

  const providers = Array.from(
    new Set(models.filter((m) => !m.isGroup).map((m) => m.provider))
  ).sort();
  const groups = models.filter((m) => m.isGroup).map((m) => m.id);

  const snapshot: ModelCatalogSnapshot = {
    models,
    providers,
    groups,
    sources: Array.from(sourceSet),
    fetchedAt: new Date().toISOString(),
  };

  cachedCatalog = {
    key: cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    snapshot,
  };

  return snapshot;
}

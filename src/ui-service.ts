import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { clearDiscoveryCache, discoverRules } from "./core/discovery.ts";
import { matchesModelPatterns } from "./core/matcher.ts";
import { parseFrontmatter, rewriteInlineConditionalBlocks } from "./core/parser.ts";
import { formatInjectedBlock, resolveRules } from "./core/resolver.ts";
import type { InjectionPosition, MatchTarget, PluginOptions, ProtocolName } from "./core/types.ts";
import { hitLogStore, type HitLogStore } from "./hit-log.ts";
import { loadMagpieModelCatalog } from "./model-catalog.ts";
import {
  DEFAULT_UI_PORT,
  resolveEffectiveOptions,
  savePersistedSettings,
} from "./settings.ts";
import { BUILTIN_TEMPLATES, findTemplateById } from "./templates.ts";

export const CAPABILITY_HEADER = "x-prompt-match-capability";
const MAX_BODY_BYTES = 512 * 1024;
const APP_HTML_PATH = path.resolve(import.meta.dir, "..", "ui", "app.html");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sanitizeRuleFileName(input: string): string | null {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return null;
  }
  const withExt = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
  if (!/^[A-Za-z0-9._*+-]+$/.test(withExt)) {
    return null;
  }
  return withExt;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

function listGlobalRuleFiles(promptsDir: string): Array<{
  fileName: string;
  filePath: string;
  raw: string;
  meta: ReturnType<typeof parseFrontmatter>["meta"];
  body: string;
  mtimeMs: number;
}> {
  try {
    if (!fs.existsSync(promptsDir)) return [];
    const entries = fs.readdirSync(promptsDir, { withFileTypes: true });
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const filePath = path.join(promptsDir, e.name);
        const raw = fs.readFileSync(filePath, "utf8");
        const stat = fs.statSync(filePath);
        const parsed = parseFrontmatter(raw);
        return {
          fileName: e.name,
          filePath,
          raw,
          meta: parsed.meta,
          body: parsed.body,
          mtimeMs: stat.mtimeMs,
        };
      });
  } catch {
    return [];
  }
}

export interface UiServiceHandle {
  server: http.Server;
  port: number;
  capability: string;
  close: () => Promise<void>;
}

export interface CreateUiServiceParams {
  port?: number;
  env?: NodeJS.ProcessEnv;
  ctxOptions?: () => Record<string, unknown> | undefined;
  logs?: HitLogStore;
  skipCliCatalog?: boolean;
  skipGatewayCatalog?: boolean;
}

export function createUiService({
  port = DEFAULT_UI_PORT,
  env = process.env,
  ctxOptions = () => undefined,
  logs = hitLogStore,
  skipCliCatalog = false,
  skipGatewayCatalog = false,
}: CreateUiServiceParams = {}): Promise<UiServiceHandle> {
  const capability = randomBytes(32).toString("base64url");

  const getOptions = (): PluginOptions => resolveEffectiveOptions(ctxOptions(), env);

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = fs
          .readFileSync(APP_HTML_PATH, "utf8")
          .replace("__PROMPT_MATCH_CAPABILITY__", JSON.stringify(capability));
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      let corsHeaders: Record<string, string> = { vary: "Origin" };

      if (pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        // Magpie renders plugin pages inside a sandboxed iframe (opaque Origin: null)
        // or proxies them same-origin (no Origin header). Refuse any external origin.
        if (origin !== undefined && origin !== "null") {
          sendJson(res, 403, { error: "Forbidden: origin refused" }, corsHeaders);
          return;
        }
        if (origin === "null") {
          corsHeaders = {
            "access-control-allow-origin": "null",
            vary: "Origin",
          };
        }

        if (method === "OPTIONS") {
          res.writeHead(204, {
            "cache-control": "no-store",
            ...corsHeaders,
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": `content-type, accept, ${CAPABILITY_HEADER}`,
            "access-control-max-age": "600",
            ...(req.headers["access-control-request-private-network"] === "true"
              ? { "access-control-allow-private-network": "true" }
              : {}),
          });
          res.end();
          return;
        }

        const headerVal = String(req.headers[CAPABILITY_HEADER] || "");
        if (!safeEqual(headerVal, capability)) {
          sendJson(res, 403, { error: "Forbidden: invalid capability token" }, corsHeaders);
          return;
        }
      }

      const replyJson = (status: number, payload: unknown) =>
        sendJson(res, status, payload, corsHeaders);

      if (method === "GET" && pathname === "/api/status") {
        const options = getOptions();
        replyJson(200, {
          options,
          stats: logs.getStats(),
          recentCwds: logs.getRecentCwds(),
          templates: BUILTIN_TEMPLATES.map((t) => ({
            id: t.id,
            fileName: t.fileName,
            title: t.title,
            description: t.description,
          })),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/models") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const options = getOptions();
        const catalog = await loadMagpieModelCatalog({
          env,
          logs,
          forceRefresh,
          skipCli: skipCliCatalog,
          skipGateway: skipGatewayCatalog,
        });
        const discovered = discoverRules(undefined, options);
        const enabledGlobal = discovered.globalRules.filter((r) => r.enabled);

        const modelsWithRules = catalog.models.map((m) => {
          const matchedRules = enabledGlobal
            .filter((r) =>
              matchesModelPatterns(r.models, {
                provider: m.isGroup ? undefined : m.provider,
                model: m.isGroup ? m.id : m.model,
                requestedModel: m.id,
              })
            )
            .map((r) => r.name);
          return { ...m, matchedRules };
        });

        replyJson(200, {
          ...catalog,
          models: modelsWithRules,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/rules") {
        const options = getOptions();
        const cwdParam = url.searchParams.get("cwd") || logs.getRecentCwds()[0] || "";
        const globalFiles = listGlobalRuleFiles(options.promptsDir);
        const discovered = discoverRules(cwdParam || undefined, options);
        replyJson(200, {
          promptsDir: options.promptsDir,
          cwd: cwdParam,
          scannedDirs: discovered.scannedDirs,
          globalFiles,
          projectRules: discovered.projectRules,
        });
        return;
      }

      if ((method === "POST" || method === "PUT") && pathname === "/api/rules") {
        const body = await readJsonBody(req);
        const safeName = sanitizeRuleFileName(String(body.fileName || ""));
        if (!safeName) {
          replyJson(400, { error: "Invalid rule filename" });
          return;
        }
        const content = typeof body.content === "string" ? body.content : "";
        const options = getOptions();
        fs.mkdirSync(options.promptsDir, { recursive: true });
        const targetPath = path.join(options.promptsDir, safeName);
        if (!path.resolve(targetPath).startsWith(path.resolve(options.promptsDir))) {
          replyJson(400, { error: "Invalid rule path" });
          return;
        }
        fs.writeFileSync(targetPath, content, "utf8");
        clearDiscoveryCache();
        replyJson(200, { ok: true, fileName: safeName, filePath: targetPath });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/rules/")) {
        const rawName = decodeURIComponent(pathname.slice("/api/rules/".length));
        const safeName = sanitizeRuleFileName(rawName);
        if (!safeName) {
          replyJson(400, { error: "Invalid rule filename" });
          return;
        }
        const options = getOptions();
        const targetPath = path.join(options.promptsDir, safeName);
        if (!path.resolve(targetPath).startsWith(path.resolve(options.promptsDir))) {
          replyJson(400, { error: "Invalid rule path" });
          return;
        }
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
          clearDiscoveryCache();
        }
        replyJson(200, { ok: true, deleted: safeName });
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/templates/")) {
        const templateId = decodeURIComponent(pathname.slice("/api/templates/".length));
        const template = findTemplateById(templateId);
        if (!template) {
          replyJson(404, { error: "Template not found" });
          return;
        }
        const options = getOptions();
        fs.mkdirSync(options.promptsDir, { recursive: true });
        const targetPath = path.join(options.promptsDir, template.fileName);
        fs.writeFileSync(targetPath, template.content, "utf8");
        clearDiscoveryCache();
        replyJson(200, {
          ok: true,
          fileName: template.fileName,
          filePath: targetPath,
          content: template.content,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/test") {
        const body = await readJsonBody(req);
        const options = getOptions();
        const model = String(body.model || "").trim();
        const provider = String(body.provider || "").trim() || undefined;
        const requestedModel = String(body.requestedModel || "").trim() || undefined;
        const cwd = String(body.cwd || "").trim() || undefined;
        const agent = String(body.agent || "").trim() || undefined;
        const protocol = (String(body.protocol || "anthropic") as ProtocolName) || "anthropic";
        const isUtility = Boolean(body.isUtility);
        const sampleSystemPrompt =
          typeof body.sampleSystemPrompt === "string" ? body.sampleSystemPrompt : "";

        const target: MatchTarget = {
          provider,
          model,
          requestedModel,
          agent,
          isUtility,
        };

        const snapshot = discoverRules(cwd, options);
        const inline = sampleSystemPrompt
          ? rewriteInlineConditionalBlocks(sampleSystemPrompt, target)
          : {
              text: "",
              changed: false,
              strippedCount: 0,
              unwrappedCount: 0,
              matchedSignatures: [] as string[],
            };

        const plan = resolveRules(
          snapshot.allRules,
          target,
          inline.matchedSignatures,
          inline.strippedCount,
          inline.unwrappedCount
        );

        const label = provider ? `${provider}/${model}` : model;
        const previews: Record<InjectionPosition, string> = {
          "system-start": formatInjectedBlock(plan.byPosition["system-start"], "system-start", label),
          "system-end": formatInjectedBlock(plan.byPosition["system-end"], "system-end", label),
          "developer-reminder": formatInjectedBlock(
            plan.byPosition["developer-reminder"],
            "developer-reminder",
            label
          ),
        };

        const injectedChars =
          previews["system-start"].length +
          previews["system-end"].length +
          previews["developer-reminder"].length;

        replyJson(200, {
          protocol,
          target,
          scannedDirs: snapshot.scannedDirs,
          totalCandidates: snapshot.allRules.length,
          matchedRules: plan.matchedRules.map((r) => ({
            id: r.id,
            name: r.name,
            scope: r.scope,
            depth: r.depth,
            mode: r.mode,
            position: r.position,
            models: r.models,
            agents: r.agents,
            chars: r.content.length,
          })),
          strippedInlineBlocks: plan.strippedInlineBlocks,
          unwrappedInlineBlocks: plan.unwrappedInlineBlocks,
          rewrittenSampleSystem: inline.text,
          previews,
          injectedChars,
          estimatedTokens: Math.ceil(injectedChars / 3.5),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/logs") {
        const limit = Number(url.searchParams.get("limit") || 100);
        replyJson(200, {
          entries: logs.list(Number.isFinite(limit) ? limit : 100),
          stats: logs.getStats(),
        });
        return;
      }

      if (method === "DELETE" && pathname === "/api/logs") {
        logs.clear();
        replyJson(200, { ok: true });
        return;
      }

      if (method === "PUT" && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        const saved = savePersistedSettings(body as Partial<PluginOptions>, env);
        clearDiscoveryCache();
        replyJson(200, { ok: true, options: saved });
        return;
      }

      replyJson(404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.unref?.();
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: boundPort,
        capability,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

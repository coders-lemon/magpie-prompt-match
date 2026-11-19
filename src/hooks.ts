import { randomUUID } from "node:crypto";
import { attachCarrier } from "./core/carrier.ts";
import { discoverRules } from "./core/discovery.ts";
import { applyDirectStage } from "./core/pipeline.ts";
import { detectProtocol } from "./core/protocols.ts";
import { resolveRules } from "./core/resolver.ts";
import type { CarrierPayload, CarrierRule, PromptRule } from "./core/types.ts";
import { isUtilityRequest } from "./core/utility-guard.ts";
import { hitLogStore } from "./hit-log.ts";
import { resolveEffectiveOptions } from "./settings.ts";
import { createUiService, type UiServiceHandle } from "./ui-service.ts";

export interface MagpieHookContext {
  protocol?: string;
  model?: string;
  stream?: boolean;
  path?: string;
  origin?: string;
  agent?: string;
  session?: string;
  cwd?: string;
  query?: Record<string, string>;
  options?: Record<string, unknown>;
  state?: Record<string, unknown>;
  signal?: AbortSignal;
  report?: (code: string, bytes?: number) => void;
}

interface HookRequestState {
  reqId: string;
  cwd: string;
  agent: string;
  requestedModel: string;
  isUtility: boolean;
  candidateRules: PromptRule[];
  twoStage: boolean;
}

let uiServicePromise: Promise<UiServiceHandle | null> | null = null;
let uiServicePort: number | null = null;
let latestCtxOptions: Record<string, unknown> | undefined;

function ensureUiServiceStarted(port: number): void {
  if (process.env.PROMPT_MATCH_DISABLE_UI === "1") return;
  if (uiServicePromise && uiServicePort === port) return;

  const previous = uiServicePromise;
  uiServicePort = port;
  uiServicePromise = Promise.resolve(previous)
    .then((handle) => handle?.close())
    .catch(() => {})
    .then(() =>
      createUiService({
        port,
        ctxOptions: () => latestCtxOptions,
      })
    )
    .catch(() => null);
}

// Start UI service eagerly when loaded by Magpie's plugin host (unless disabled in tests/CLI)
if (process.env.PROMPT_MATCH_DISABLE_UI !== "1") {
  const initialOpts = resolveEffectiveOptions();
  ensureUiServiceStarted(initialOpts.uiPort);
}

function toCarrierRules(rules: PromptRule[]): CarrierRule[] {
  return rules
    .filter((r) => r.enabled && r.content.trim().length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      depth: r.depth,
      models: r.models,
      agents: r.agents,
      mode: r.mode,
      position: r.position,
      priority: r.priority,
      includeUtility: r.includeUtility,
      content: r.content,
      blockSignature: r.blockSignature,
    }));
}

function hasInlineModelMarker(body: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(body).includes("@model");
  } catch {
    return false;
  }
}

/**
 * Stage 1 (Magpie Gateway Request Hook — runs in Bun before routing).
 * Discovers global + project rules from disk (mtime-cached), filters utility calls,
 * and either attaches a compact carrier for Stage 2 (`middleware.onProvider`) or
 * resolves directly when `pipelineMode === "hooks-only"`.
 */
export async function onRequest(
  body: Record<string, unknown> | null | undefined,
  ctx: MagpieHookContext = {}
): Promise<Record<string, unknown> | undefined> {
  if (!body || typeof body !== "object") return undefined;

  try {
    latestCtxOptions = ctx.options;
    const options = resolveEffectiveOptions(ctx.options);
    ensureUiServiceStarted(options.uiPort);

    const protocol = detectProtocol(body, ctx.protocol);
    const requestedModel = String(ctx.model || body.model || "").trim();
    const agent = String(ctx.agent || "").trim();
    const cwd = String(ctx.cwd || "").trim();
    const reqId = randomUUID();

    if (!options.enabled) {
      hitLogStore.record({
        id: reqId,
        timestamp: new Date().toISOString(),
        agent,
        cwd,
        protocol,
        requestedModel,
        resolvedModel: requestedModel,
        stage: "hooks",
        status: "skipped-disabled",
        matchedRuleNames: [],
        strippedBlocks: 0,
        injectedBytes: 0,
      });
      ctx.report?.("skipped", 0);
      return undefined;
    }

    const utility = options.skipUtilityRequests && isUtilityRequest(body, protocol);
    const snapshot = discoverRules(cwd || undefined, options);
    const activeCandidates = snapshot.allRules.filter((r) => r.enabled);
    const hasInline = hasInlineModelMarker(body);

    // If utility request and no candidate rule explicitly opts into includeUtility
    const anyUtilityRule = activeCandidates.some((r) => r.includeUtility);
    if (utility && !anyUtilityRule && !hasInline) {
      hitLogStore.record({
        id: reqId,
        timestamp: new Date().toISOString(),
        agent,
        cwd,
        protocol,
        requestedModel,
        resolvedModel: requestedModel,
        stage: "hooks",
        status: "skipped-utility",
        matchedRuleNames: [],
        strippedBlocks: 0,
        injectedBytes: 0,
      });
      ctx.report?.("skipped", 0);
      return undefined;
    }

    if (activeCandidates.length === 0 && !hasInline) {
      hitLogStore.record({
        id: reqId,
        timestamp: new Date().toISOString(),
        agent,
        cwd,
        protocol,
        requestedModel,
        resolvedModel: requestedModel,
        stage: "hooks",
        status: "no-match",
        matchedRuleNames: [],
        strippedBlocks: 0,
        injectedBytes: 0,
      });
      ctx.report?.("empty", 0);
      return undefined;
    }

    const pipelineMode = String(ctx.options?.pipelineMode || "two-stage");
    const useTwoStage = pipelineMode !== "hooks-only";

    if (ctx.state && typeof ctx.state === "object") {
      const stateEntry: HookRequestState = {
        reqId,
        cwd,
        agent,
        requestedModel,
        isUtility: utility,
        candidateRules: activeCandidates,
        twoStage: useTwoStage,
      };
      ctx.state.__promptMatch = stateEntry;
    }

    if (!useTwoStage) {
      const direct = applyDirectStage(body, protocol, activeCandidates, {
        model: requestedModel,
        requestedModel,
        agent,
        isUtility: utility,
      });

      hitLogStore.record({
        id: reqId,
        timestamp: new Date().toISOString(),
        agent,
        cwd,
        protocol,
        requestedModel,
        resolvedModel: requestedModel,
        stage: "hooks",
        status:
          direct.plan.matchedRules.length > 0 || direct.plan.strippedInlineBlocks > 0
            ? "matched"
            : "no-match",
        matchedRuleNames: direct.plan.matchedRules.map((r) => r.name),
        strippedBlocks: direct.plan.strippedInlineBlocks,
        injectedBytes: direct.injectedBytes,
      });

      ctx.report?.(direct.changed ? "ready" : "empty", direct.injectedBytes);
      return direct.changed ? direct.body : undefined;
    }

    // Two-stage mode: attach compact carrier so middleware.onProvider evaluates
    // against the exact resolved ctx.provider.model (including routing groups & fallbacks)
    const carrier: CarrierPayload = {
      v: 1,
      reqId,
      agent: agent || undefined,
      requestedModel: requestedModel || undefined,
      isUtility: utility,
      rules: toCarrierRules(activeCandidates),
    };

    const nextBody = attachCarrier(body, protocol, carrier);

    // Pre-compute an optimistic preview for direct (non-group) models; onResponse refines it
    const isGroup = /(?:^|\/)group\//i.test(requestedModel);
    const previewPlan = !isGroup
      ? resolveRules(activeCandidates, {
          model: requestedModel,
          requestedModel,
          agent,
          isUtility: utility,
        })
      : null;

    hitLogStore.record({
      id: reqId,
      timestamp: new Date().toISOString(),
      agent,
      cwd,
      protocol,
      requestedModel,
      resolvedModel: isGroup ? "(routing...)" : requestedModel,
      stage: "hooks",
      status: isGroup
        ? "deferred"
        : previewPlan && previewPlan.matchedRules.length > 0
          ? "matched"
          : "deferred",
      matchedRuleNames: previewPlan ? previewPlan.matchedRules.map((r) => r.name) : [],
      strippedBlocks: 0,
      injectedBytes: previewPlan
        ? previewPlan.matchedRules.reduce((sum, r) => sum + r.content.length, 0)
        : 0,
      note: isGroup ? "Waiting for provider resolution" : undefined,
    });

    ctx.report?.("ready", JSON.stringify(carrier).length);
    return nextBody;
  } catch {
    // Fail-open: never block requests
    ctx.report?.("invalid", 0);
    return undefined;
  }
}

/**
 * Best-effort completion hook: extracts actual served model from completed reply
 * to finalize the Hit Log entry (especially useful for routing groups & fallbacks).
 */
export async function onResponse(
  reply: Record<string, unknown> | null | undefined,
  ctx: MagpieHookContext = {}
): Promise<void> {
  try {
    const state = ctx.state?.__promptMatch as HookRequestState | undefined;
    if (!state || !state.twoStage) return;

    const servedModel =
      (reply && typeof reply.model === "string" && reply.model.trim()) ||
      (reply &&
        typeof (reply as { response?: { model?: unknown } }).response?.model === "string" &&
        String((reply as { response: { model: string } }).response.model).trim()) ||
      state.requestedModel;

    const plan = resolveRules(state.candidateRules, {
      model: servedModel,
      requestedModel: state.requestedModel,
      agent: state.agent,
      isUtility: state.isUtility,
    });

    const injectedBytes = plan.matchedRules.reduce((sum, r) => sum + r.content.length, 0);

    hitLogStore.updateById(state.reqId, {
      resolvedModel: servedModel,
      stage: "response",
      status: plan.matchedRules.length > 0 ? "matched" : "no-match",
      matchedRuleNames: plan.matchedRules.map((r) => r.name),
      injectedBytes,
      note:
        servedModel !== state.requestedModel
          ? `Resolved from ${state.requestedModel}`
          : undefined,
    });
  } catch {
    // Best-effort only
  }
}

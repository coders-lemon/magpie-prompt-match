import { extractAndStripCarrier } from "./carrier.ts";
import {
  applyResolvedPlan,
  detectProtocol,
  filterInlineConditionalBlocks,
} from "./protocols.ts";
import { resolveRules } from "./resolver.ts";
import type {
  CarrierRule,
  MatchTarget,
  PromptRule,
  ProtocolName,
  ResolvedRulePlan,
} from "./types.ts";

export interface StageResult {
  body: Record<string, unknown>;
  changed: boolean;
  protocol: ProtocolName;
  plan: ResolvedRulePlan;
  injectedBytes: number;
  carrierFound: boolean;
  reqId?: string;
}

/**
 * Single-stage evaluation (used for dry-run testing, hooks-only mode, or direct resolution).
 */
export function applyDirectStage(
  body: Record<string, unknown>,
  protocolHint: string | undefined,
  rules: Array<PromptRule | CarrierRule>,
  target: MatchTarget
): StageResult {
  const protocol = detectProtocol(body, protocolHint);

  const inline = filterInlineConditionalBlocks(body, protocol, target);
  const plan = resolveRules(
    rules,
    target,
    inline.matchedSignatures,
    inline.strippedCount,
    inline.unwrappedCount
  );

  const label = target.provider
    ? `${target.provider}/${target.model}`
    : target.model;
  const injected = applyResolvedPlan(inline.body, protocol, plan, label);

  return {
    body: injected.body,
    changed: inline.changed || injected.injectedBytes > 0,
    protocol,
    plan,
    injectedBytes: injected.injectedBytes,
    carrierFound: false,
  };
}

/**
 * Stage 2 (middleware.onProvider):
 * 1. Always strips any carrier block attached by Stage 1 (hooks.onRequest).
 * 2. Evaluates rules against the ACTUAL resolved upstream provider + model.
 * 3. Strips unmatched inline @model blocks and injects matched prompts.
 */
export function applyProviderStage(
  body: Record<string, unknown>,
  protocolHint: string | undefined,
  providerId: string | undefined,
  providerModel: string | undefined,
  fallbackRequestedModel?: string
): StageResult {
  const protocol = detectProtocol(body, protocolHint);
  const extracted = extractAndStripCarrier(body, protocol);

  const targetModel =
    (providerModel || "").trim() ||
    (extracted.payload?.requestedModel || "").trim() ||
    (fallbackRequestedModel || "").trim() ||
    (typeof body.model === "string" ? body.model.trim() : "");

  const target: MatchTarget = {
    provider: providerId ? providerId.trim() : undefined,
    model: targetModel,
    requestedModel: extracted.payload?.requestedModel || fallbackRequestedModel,
    agent: extracted.payload?.agent,
    isUtility: extracted.payload?.isUtility ?? false,
  };

  const candidateRules = extracted.payload?.rules ?? [];

  const inline = filterInlineConditionalBlocks(extracted.body, protocol, target);
  const plan = resolveRules(
    candidateRules,
    target,
    inline.matchedSignatures,
    inline.strippedCount,
    inline.unwrappedCount
  );

  const label = target.provider
    ? `${target.provider}/${target.model}`
    : target.model;
  const injected = applyResolvedPlan(inline.body, protocol, plan, label);

  return {
    body: injected.body,
    changed: extracted.found || inline.changed || injected.injectedBytes > 0,
    protocol,
    plan,
    injectedBytes: injected.injectedBytes,
    carrierFound: extracted.found,
    reqId: extracted.payload?.reqId,
  };
}

import { applyProviderStage } from "./core/pipeline.ts";

interface MiddlewareContext {
  protocol?: string;
  model?: string;
  provider?: {
    id?: string;
    name?: string;
    account?: string;
    model?: string;
  };
  options?: Record<string, unknown>;
}

/**
 * Magpie synchronous gateway middleware (runs in embedded moejs engine).
 * Executes on every upstream provider attempt after routing / fallback resolution.
 */
export function onProvider(
  body: Record<string, unknown> | null | undefined,
  ctx?: MiddlewareContext
): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;

  try {
    const providerId = ctx?.provider?.id;
    const providerModel = ctx?.provider?.model;
    const result = applyProviderStage(
      body,
      ctx?.protocol,
      providerId,
      providerModel,
      ctx?.model
    );

    if (!result.changed) return undefined;
    return result.body;
  } catch {
    // Fail-open: never break upstream requests if middleware throws
    return undefined;
  }
}

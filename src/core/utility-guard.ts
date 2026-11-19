import type { ProtocolName } from "./types.ts";

const UTILITY_PROMPT_PATTERNS = [
  /generate\s+(a\s+)?(concise\s+|short\s+)?title/i,
  /summarize\s+(this\s+|the\s+)?conversation/i,
  /conversation\s+compaction/i,
  /compact\s+(the\s+)?(conversation|context|history)/i,
  /title\s+for\s+(this\s+)?(chat|thread|session|conversation)/i,
  /生成.*?(标题|摘要)/,
  /总结.*?(对话|会话)/,
];

function extractSystemPreview(body: Record<string, unknown>, protocol: ProtocolName): string {
  const chunks: string[] = [];

  if (protocol === "anthropic" || body.system !== undefined) {
    if (typeof body.system === "string") {
      chunks.push(body.system);
    } else if (Array.isArray(body.system)) {
      for (const item of body.system) {
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          chunks.push((item as { text: string }).text);
        }
      }
    }
  }

  if (typeof body.instructions === "string") {
    chunks.push(body.instructions);
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = (msg as { role?: unknown }).role;
      if (role === "system" || role === "developer") {
        const content = (msg as { content?: unknown }).content;
        if (typeof content === "string") chunks.push(content);
      }
    }
  }

  const sysInst = body.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
  if (sysInst && Array.isArray(sysInst.parts)) {
    for (const part of sysInst.parts) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }

  return chunks.join("\n").slice(0, 2000);
}

function hasTools(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (Array.isArray(body.functions) && body.functions.length > 0) return true;
  return false;
}

function getMaxOutputTokens(body: Record<string, unknown>): number | undefined {
  const candidates = [
    body.max_tokens,
    body.max_output_tokens,
    body.max_completion_tokens,
    (body.generationConfig as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens,
  ];
  for (const val of candidates) {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * Heuristic check for lightweight non-coding utility requests (e.g. thread title
 * generation, short summarization, compaction without tool calls).
 */
export function isUtilityRequest(
  body: Record<string, unknown> | null | undefined,
  protocol: ProtocolName
): boolean {
  if (!body || typeof body !== "object") return false;
  if (hasTools(body)) return false;

  const maxTokens = getMaxOutputTokens(body);
  if (maxTokens !== undefined && maxTokens <= 256) {
    return true;
  }

  const systemText = extractSystemPreview(body, protocol);
  if (systemText && UTILITY_PROMPT_PATTERNS.some((re) => re.test(systemText))) {
    return true;
  }

  return false;
}

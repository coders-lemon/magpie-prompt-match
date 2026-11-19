import { rewriteInlineConditionalBlocks } from "./parser.ts";
import { formatInjectedBlock } from "./resolver.ts";
import type {
  InjectionPosition,
  MatchTarget,
  ProtocolName,
  ResolvedRulePlan,
} from "./types.ts";

/**
 * Detect API protocol from payload structure first (handles post-translation onProvider
 * bodies accurately), falling back to ctx.protocol hint.
 */
export function detectProtocol(
  body: Record<string, unknown> | null | undefined,
  hint?: string
): ProtocolName {
  if (body && typeof body === "object") {
    if (body.systemInstruction !== undefined || Array.isArray(body.contents)) {
      return "gemini";
    }
    if (
      (body.input !== undefined || body.instructions !== undefined) &&
      !Array.isArray(body.messages)
    ) {
      return "responses";
    }
    if (body.system !== undefined || body.anthropic_version !== undefined) {
      return "anthropic";
    }
    if (Array.isArray(body.messages)) {
      if (hint === "anthropic") return "anthropic";
      return "chat";
    }
  }

  if (
    hint === "anthropic" ||
    hint === "chat" ||
    hint === "responses" ||
    hint === "gemini"
  ) {
    return hint;
  }
  return "unknown";
}

function shallowClone<T extends Record<string, unknown>>(obj: T): T {
  return { ...obj };
}

/**
 * Traverse string fields inside system/instructions/messages/input/contents and apply
 * a text transform callback. Returns a cloned body only if mutated.
 */
export function transformProtocolTexts(
  body: Record<string, unknown>,
  protocol: ProtocolName,
  transform: (text: string) => { text: string; changed: boolean }
): { body: Record<string, unknown>; changed: boolean } {
  let mutated = false;
  let next = body;

  const ensureClone = () => {
    if (!mutated) {
      next = shallowClone(body);
      mutated = true;
    }
  };

  if (protocol === "anthropic") {
    if (typeof body.system === "string") {
      const res = transform(body.system);
      if (res.changed) {
        ensureClone();
        next.system = res.text;
      }
    } else if (Array.isArray(body.system)) {
      let arrChanged = false;
      const newSys = body.system.map((item) => {
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          const res = transform((item as { text: string }).text);
          if (res.changed) {
            arrChanged = true;
            return { ...(item as Record<string, unknown>), text: res.text };
          }
        }
        return item;
      });
      if (arrChanged) {
        ensureClone();
        next.system = newSys.filter(
          (item) =>
            !(
              item &&
              typeof item === "object" &&
              (item as { type?: unknown }).type === "text" &&
              (item as { text?: unknown }).text === ""
            )
        );
      }
    }
  }

  if (protocol === "responses" && typeof body.instructions === "string") {
    const res = transform(body.instructions);
    if (res.changed) {
      ensureClone();
      next.instructions = res.text;
    }
  }

  if (protocol === "responses" && Array.isArray(body.input)) {
    let arrChanged = false;
    const newInput = body.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const rec = item as Record<string, unknown>;
      if (typeof rec.content === "string") {
        const res = transform(rec.content);
        if (res.changed) {
          arrChanged = true;
          return { ...rec, content: res.text };
        }
      } else if (Array.isArray(rec.content)) {
        let partsChanged = false;
        const newParts = rec.content.map((part) => {
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            const res = transform((part as { text: string }).text);
            if (res.changed) {
              partsChanged = true;
              return { ...(part as Record<string, unknown>), text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          arrChanged = true;
          return { ...rec, content: newParts };
        }
      }
      return item;
    });
    if (arrChanged) {
      ensureClone();
      next.input = newInput;
    }
  }

  if (Array.isArray(body.messages)) {
    let msgChanged = false;
    const newMessages = body.messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const rec = msg as Record<string, unknown>;
      if (typeof rec.content === "string") {
        const res = transform(rec.content);
        if (res.changed) {
          msgChanged = true;
          return { ...rec, content: res.text };
        }
      } else if (Array.isArray(rec.content)) {
        let partsChanged = false;
        const newParts = rec.content.map((part) => {
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            const res = transform((part as { text: string }).text);
            if (res.changed) {
              partsChanged = true;
              return { ...(part as Record<string, unknown>), text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          msgChanged = true;
          return { ...rec, content: newParts };
        }
      }
      return msg;
    });
    if (msgChanged) {
      ensureClone();
      next.messages = newMessages;
    }
  }

  if (protocol === "gemini") {
    const sysInst = body.systemInstruction as { parts?: unknown[] } | undefined;
    if (sysInst && typeof sysInst === "object" && Array.isArray(sysInst.parts)) {
      let partsChanged = false;
      const newParts = sysInst.parts.map((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          const res = transform((part as { text: string }).text);
          if (res.changed) {
            partsChanged = true;
            return { ...(part as Record<string, unknown>), text: res.text };
          }
        }
        return part;
      });
      if (partsChanged) {
        ensureClone();
        next.systemInstruction = { ...sysInst, parts: newParts };
      }
    }

    if (Array.isArray(body.contents)) {
      let contentsChanged = false;
      const newContents = body.contents.map((item) => {
        if (!item || typeof item !== "object") return item;
        const rec = item as { parts?: unknown[] };
        if (!Array.isArray(rec.parts)) return item;
        let partsChanged = false;
        const newParts = rec.parts.map((part) => {
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            const res = transform((part as { text: string }).text);
            if (res.changed) {
              partsChanged = true;
              return { ...(part as Record<string, unknown>), text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          contentsChanged = true;
          return { ...(item as Record<string, unknown>), parts: newParts };
        }
        return item;
      });
      if (contentsChanged) {
        ensureClone();
        next.contents = newContents;
      }
    }
  }

  return { body: next, changed: mutated };
}

/**
 * Scan the entire request payload for Agent-loaded inline `<!-- @model: ... -->` blocks,
 * stripping unmatched ones and unwrapping matched ones in-place.
 */
export function filterInlineConditionalBlocks(
  body: Record<string, unknown>,
  protocol: ProtocolName,
  target: MatchTarget
): {
  body: Record<string, unknown>;
  changed: boolean;
  strippedCount: number;
  unwrappedCount: number;
  matchedSignatures: string[];
} {
  let strippedCount = 0;
  let unwrappedCount = 0;
  const sigSet = new Set<string>();

  const result = transformProtocolTexts(body, protocol, (text) => {
    if (!text.includes("@model")) {
      return { text, changed: false };
    }
    const rewritten = rewriteInlineConditionalBlocks(text, target);
    if (rewritten.changed) {
      strippedCount += rewritten.strippedCount;
      unwrappedCount += rewritten.unwrappedCount;
      for (const sig of rewritten.matchedSignatures) {
        sigSet.add(sig);
      }
    }
    return { text: rewritten.text, changed: rewritten.changed };
  });

  return {
    body: result.body,
    changed: result.changed,
    strippedCount,
    unwrappedCount,
    matchedSignatures: Array.from(sigSet),
  };
}

/**
 * Inject a single prompt text block into the payload at the given position,
 * preserving prompt cache prefixes (e.g. Anthropic cache_control breakpoints).
 */
export function injectPromptText(
  body: Record<string, unknown>,
  protocol: ProtocolName,
  position: InjectionPosition,
  text: string
): Record<string, unknown> {
  if (!text) return body;
  const next = shallowClone(body);

  if (protocol === "anthropic") {
    if (position === "developer-reminder" && Array.isArray(next.messages)) {
      const msgs = [...next.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i] as Record<string, unknown> | undefined;
        if (msg && msg.role === "user") {
          if (typeof msg.content === "string") {
            msgs[i] = { ...msg, content: `${msg.content}\n\n${text}` };
          } else if (Array.isArray(msg.content)) {
            msgs[i] = {
              ...msg,
              content: [...msg.content, { type: "text", text }],
            };
          }
          next.messages = msgs;
          return next;
        }
      }
    }

    // system-end or system-start (or fallback when no user message)
    if (Array.isArray(next.system)) {
      const block = { type: "text", text };
      next.system =
        position === "system-start"
          ? [block, ...next.system]
          : [...next.system, block];
    } else if (typeof next.system === "string" && next.system.length > 0) {
      // Keep as structured array when appending so prefix stays clean
      next.system =
        position === "system-start"
          ? `${text}\n\n${next.system}`
          : `${next.system}\n\n${text}`;
    } else {
      next.system = [{ type: "text", text }];
    }
    return next;
  }

  if (protocol === "chat") {
    const msgs = Array.isArray(next.messages) ? [...next.messages] : [];
    const usesDeveloper = msgs.some(
      (m) => m && typeof m === "object" && (m as { role?: unknown }).role === "developer"
    );
    const sysRole = usesDeveloper ? "developer" : "system";

    if (position === "system-start") {
      msgs.unshift({ role: sysRole, content: text });
    } else if (position === "developer-reminder") {
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: unknown } | undefined;
        if (m && m.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        msgs.splice(lastUserIdx, 0, { role: sysRole, content: text });
      } else {
        msgs.push({ role: sysRole, content: text });
      }
    } else {
      // system-end: insert immediately after leading system/developer block
      let insertIdx = 0;
      while (insertIdx < msgs.length) {
        const role = (msgs[insertIdx] as { role?: unknown } | undefined)?.role;
        if (role === "system" || role === "developer") {
          insertIdx += 1;
        } else {
          break;
        }
      }
      msgs.splice(insertIdx, 0, { role: sysRole, content: text });
    }

    next.messages = msgs;
    return next;
  }

  if (protocol === "responses") {
    if (position === "developer-reminder") {
      if (Array.isArray(next.input)) {
        next.input = [...next.input, { role: "developer", content: text }];
        return next;
      }
      // Fall through to instructions if input is a plain string
    }

    if (typeof next.instructions === "string" && next.instructions.length > 0) {
      next.instructions =
        position === "system-start"
          ? `${text}\n\n${next.instructions}`
          : `${next.instructions}\n\n${text}`;
    } else {
      next.instructions = text;
    }
    return next;
  }

  if (protocol === "gemini") {
    if (position === "developer-reminder" && Array.isArray(next.contents)) {
      const contents = [...next.contents];
      for (let i = contents.length - 1; i >= 0; i--) {
        const item = contents[i] as { role?: unknown; parts?: unknown[] } | undefined;
        if (item && (item.role === "user" || item.role === undefined) && Array.isArray(item.parts)) {
          contents[i] = { ...item, parts: [...item.parts, { text }] };
          next.contents = contents;
          return next;
        }
      }
    }

    const existing = next.systemInstruction as { parts?: unknown[] } | undefined;
    const existingParts = existing && Array.isArray(existing.parts) ? [...existing.parts] : [];
    const newParts =
      position === "system-start"
        ? [{ text }, ...existingParts]
        : [...existingParts, { text }];
    next.systemInstruction = { ...(existing || {}), parts: newParts };
    return next;
  }

  return body;
}

/**
 * Apply a resolved rule plan onto the request body across all positions.
 */
export function applyResolvedPlan(
  body: Record<string, unknown>,
  protocol: ProtocolName,
  plan: ResolvedRulePlan,
  modelLabel: string
): { body: Record<string, unknown>; injectedBytes: number } {
  let current = body;
  let injectedBytes = 0;

  const positions: InjectionPosition[] = [
    "system-start",
    "system-end",
    "developer-reminder",
  ];

  for (const pos of positions) {
    const rules = plan.byPosition[pos];
    if (!rules || rules.length === 0) continue;
    const text = formatInjectedBlock(rules, pos, modelLabel);
    if (!text) continue;
    current = injectPromptText(current, protocol, pos, text);
    injectedBytes += text.length;
  }

  return { body: current, injectedBytes };
}

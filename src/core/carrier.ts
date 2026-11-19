import { injectPromptText, transformProtocolTexts } from "./protocols.ts";
import type { CarrierPayload, ProtocolName } from "./types.ts";

const CARRIER_PREFIX = "<!--magpie-prompt-match-carrier:";
const CARRIER_SUFFIX = "-->";
const CARRIER_RE = /<!--magpie-prompt-match-carrier:([A-Za-z0-9+/=_-]+)-->/g;

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Pure-JS UTF-8 -> Base64 encoder (zero Node/Bun globals, 100% moejs compatible).
 */
export function utf8ToBase64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }

  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;

    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += has2 ? B64_CHARS[b2 & 63] : "=";
  }
  return out;
}

/**
 * Pure-JS Base64 -> UTF-8 decoder (zero Node/Bun globals, 100% moejs compatible).
 */
export function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i]);
    const c1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? -1 : B64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? -1 : B64_CHARS.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) break;

    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) {
      bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 >= 0) {
        bytes.push(((c2 & 3) << 6) | c3);
      }
    }
  }

  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < bytes.length) {
      const b1 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)
      );
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const cp =
        (((b0 & 0x07) << 18) |
          ((b1 & 0x3f) << 12) |
          ((b2 & 0x3f) << 6) |
          (b3 & 0x3f)) -
        0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

export function encodeCarrier(payload: CarrierPayload): string {
  return `${CARRIER_PREFIX}${utf8ToBase64(JSON.stringify(payload))}${CARRIER_SUFFIX}`;
}

export function decodeCarrier(encoded: string): CarrierPayload | null {
  try {
    const parsed = JSON.parse(base64ToUtf8(encoded)) as CarrierPayload;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rules)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Attach carrier payload into system prompt so it survives Magpie hook validation
 * and cross-protocol translation before being stripped in middleware.onProvider.
 */
export function attachCarrier(
  body: Record<string, unknown>,
  protocol: ProtocolName,
  payload: CarrierPayload
): Record<string, unknown> {
  const token = encodeCarrier(payload);
  return injectPromptText(body, protocol, "system-end", token);
}

/**
 * Extract AND unconditionally strip any carrier tokens from the request body.
 * Also removes any now-empty system/developer messages created solely to carry the token.
 */
export function extractAndStripCarrier(
  body: Record<string, unknown>,
  protocol: ProtocolName
): {
  body: Record<string, unknown>;
  payload: CarrierPayload | null;
  found: boolean;
} {
  let payload: CarrierPayload | null = null;
  let found = false;

  const transformed = transformProtocolTexts(body, protocol, (text) => {
    if (!text.includes(CARRIER_PREFIX)) {
      return { text, changed: false };
    }

    CARRIER_RE.lastIndex = 0;
    const cleaned = text
      .replace(CARRIER_RE, (_match, encoded: string) => {
        found = true;
        if (!payload) {
          payload = decodeCarrier(encoded);
        }
        return "";
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { text: cleaned, changed: true };
  });

  if (!found) {
    return { body, payload: null, found: false };
  }

  // Prune empty carrier-only messages/parts so upstream never sees blank system entries
  let next = transformed.body;
  if (protocol === "chat" && Array.isArray(next.messages)) {
    next = {
      ...next,
      messages: next.messages.filter((m) => {
        if (!m || typeof m !== "object") return true;
        const rec = m as { role?: unknown; content?: unknown };
        if (
          (rec.role === "system" || rec.role === "developer") &&
          typeof rec.content === "string" &&
          rec.content.trim() === ""
        ) {
          return false;
        }
        return true;
      }),
    };
  } else if (protocol === "gemini") {
    const sysInst = next.systemInstruction as { parts?: unknown[] } | undefined;
    if (sysInst && Array.isArray(sysInst.parts)) {
      const nonEmpty = sysInst.parts.filter(
        (p) =>
          !(
            p &&
            typeof p === "object" &&
            typeof (p as { text?: unknown }).text === "string" &&
            (p as { text: string }).text.trim() === ""
          )
      );
      if (nonEmpty.length === 0) {
        const clone = { ...next };
        delete clone.systemInstruction;
        next = clone;
      } else {
        next = { ...next, systemInstruction: { ...sysInst, parts: nonEmpty } };
      }
    }
  } else if (protocol === "responses" && typeof next.instructions === "string" && next.instructions.trim() === "") {
    const clone = { ...next };
    delete clone.instructions;
    next = clone;
  }

  return { body: next, payload, found };
}

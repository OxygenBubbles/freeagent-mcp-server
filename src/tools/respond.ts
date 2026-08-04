/**
 * Shared MCP tool response helpers.
 *
 * Every tool returns pretty-printed JSON as text plus a structured payload,
 * and renders failures through handleFAError so FreeAgent's own validation
 * messages reach the caller verbatim.
 */

import { handleFAError } from "../services/freeagent.js";

export function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function fail(err: unknown) {
  return {
    content: [{ type: "text" as const, text: handleFAError(err) }],
    isError: true as const,
  };
}

/** A FreeAgent resource path or full URL, for tool input schemas. */
export function resourceRegex(collection: string): RegExp {
  return new RegExp(`^(?:https://api\\.freeagent\\.com)?/v2/${collection}/\\d+$`);
}

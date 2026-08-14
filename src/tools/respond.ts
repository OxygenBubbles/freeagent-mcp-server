/**
 * Shared MCP tool response helpers.
 *
 * Every tool returns pretty-printed JSON as text plus a structured payload,
 * and renders failures through handleFAError so FreeAgent's own validation
 * messages reach the caller verbatim.
 */

import { z } from "zod";
import { handleFAError } from "../services/freeagent.js";
import { isCalendarDate } from "../utils/money.js";

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

/**
 * Reject a call for a cross-field rule the schema cannot express.
 *
 * Object-level `.refine()` is deliberately avoided: it converts a ZodObject
 * into a ZodEffects, the MCP SDK cannot read `.shape` from that, and the tool
 * then advertises an EMPTY inputSchema — so clients see no parameters and send
 * none. That silently breaks the tool for every caller. Validate here instead.
 */
export function invalid(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

/** A FreeAgent resource path or full URL, for tool input schemas. */
export function resourceRegex(collection: string): RegExp {
  return new RegExp(`^(?:https://api\\.freeagent\\.com)?/v2/${collection}/\\d+$`);
}

/**
 * A YYYY-MM-DD date that must also be a real calendar date — a shape-only
 * regex would accept "2026-99-99" and let the API reject it later.
 */
export function dateSchema(description: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isCalendarDate, "Not a real calendar date")
    .describe(description);
}

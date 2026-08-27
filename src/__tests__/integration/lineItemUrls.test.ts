/**
 * Editing an existing invoice or bill line needs that line's own URL, and the
 * only place a caller can get one is the detail reader. If the reader drops it,
 * the update tools advertise a capability that cannot be exercised — which is
 * exactly what shipped before this test existed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  getBill: vi.fn(),
}));

vi.mock("../../services/freeagent.js", () => ({
  listInvoices: vi.fn(),
  getInvoice: mocks.getInvoice,
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  transitionInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  listBills: vi.fn(),
  getBill: mocks.getBill,
  createBill: vi.fn(),
  updateBill: vi.fn(),
  deleteBill: vi.fn(),
  replaceAttachment: vi.fn(),
  handleFAError: (err: unknown) => String(err),
}));

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: unknown }>;

/** Register a tool module and pull out one handler by name. */
function captureHandler(
  register: (server: McpServer) => void,
  toolName: string
): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(name: string, _def: unknown, ...rest: unknown[]) {
      // Some tools pass a comment-bearing extra argument before the handler,
      // so take the last function rather than a fixed position.
      if (name === toolName) {
        handler = rest.filter((a) => typeof a === "function").pop() as Handler;
      }
    },
  } as unknown as McpServer;
  register(server);
  if (!handler) throw new Error(`${toolName} was never registered`);
  return handler;
}

beforeEach(() => vi.clearAllMocks());

describe("freeagent_get_invoice", () => {
  it("returns each line's itemUrl, which freeagent_update_invoice requires", async () => {
    mocks.getInvoice.mockResolvedValue({
      url: "https://api.freeagent.com/v2/invoices/7",
      id: "7",
      contact: "https://api.freeagent.com/v2/contacts/1",
      status: "Draft",
      dated_on: "2026-08-01",
      currency: "GBP",
      net_value: "100.00",
      total_value: "120.00",
      invoice_items: [
        {
          url: "https://api.freeagent.com/v2/invoice_items/9",
          description: "Consultancy",
          item_type: "Services",
          price: "100.00",
          quantity: "1",
        },
      ],
    });

    const { registerInvoiceTools } = await import("../../tools/invoices.js");
    const handler = captureHandler(registerInvoiceTools, "freeagent_get_invoice");
    const result = await handler({ invoiceId: "7" });
    const payload = result.structuredContent as { items: Array<{ itemUrl?: string }> };

    expect(payload.items[0]!.itemUrl).toBe("https://api.freeagent.com/v2/invoice_items/9");
  });
});

describe("freeagent_get_bill", () => {
  it("returns each line's itemUrl, which freeagent_update_bill requires", async () => {
    mocks.getBill.mockResolvedValue({
      url: "https://api.freeagent.com/v2/bills/12",
      id: "12",
      contact: "https://api.freeagent.com/v2/contacts/1",
      reference: "INV-2049",
      dated_on: "2026-08-04",
      total_value: "120.00",
      bill_items: [
        {
          url: "https://api.freeagent.com/v2/bill_items/4",
          category: "https://api.freeagent.com/v2/categories/285",
          total_value: "120.00",
          description: "Hotel",
        },
      ],
    });

    const { registerBillTools } = await import("../../tools/bills.js");
    const handler = captureHandler(registerBillTools, "freeagent_get_bill");
    const result = await handler({ billId: "12" });
    const payload = result.structuredContent as { items: Array<{ itemUrl?: string }> };

    expect(payload.items[0]!.itemUrl).toBe("https://api.freeagent.com/v2/bill_items/4");
  });

  it("survives a bill with no line items", async () => {
    mocks.getBill.mockResolvedValue({
      url: "https://api.freeagent.com/v2/bills/13",
      id: "13",
      contact: "https://api.freeagent.com/v2/contacts/1",
      dated_on: "2026-08-04",
      total_value: "0.00",
    });

    const { registerBillTools } = await import("../../tools/bills.js");
    const handler = captureHandler(registerBillTools, "freeagent_get_bill");
    const result = await handler({ billId: "13" });
    const payload = result.structuredContent as { items: unknown[] };

    expect(payload.items).toEqual([]);
  });
});

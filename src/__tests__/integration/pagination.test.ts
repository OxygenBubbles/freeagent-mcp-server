/**
 * Pagination.
 *
 * FreeAgent caps a page at 100 records. Any list that stops at the first page
 * silently under-reports, which for aged debtors/creditors means a wrong
 * money total rather than a slow one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import axios from "axios";

vi.mock("axios");

const API = "https://api.freeagent.com/v2";

/** Serve `total` synthetic invoices across as many pages as the caller asks for. */
function mockCollection(collection: string, total: number) {
  const requests: Array<{ page: number; perPage: number }> = [];

  vi.mocked(axios.post).mockResolvedValue({
    data: { access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600 },
  } as never);

  vi.mocked(axios.get).mockImplementation(async (_url: string, config?: unknown) => {
    const params = ((config ?? {}) as { params?: Record<string, unknown> }).params ?? {};
    const page = Number(params["page"] ?? 1);
    const perPage = Number(params["per_page"] ?? 100);
    requests.push({ page, perPage });

    const start = (page - 1) * perPage;
    const items = Array.from(
      { length: Math.max(0, Math.min(perPage, total - start)) },
      (_, i) => ({
        url: `${API}/${collection}/${start + i + 1}`,
        due_value: "10.00",
        due_on: "2026-01-01",
        contact: `${API}/contacts/1`,
        dated_on: "2026-01-01",
        total_value: "10.00",
        status: "Open",
        currency: "GBP",
        net_value: "10.00",
        hours: "1.0",
        name: "synthetic",
        project: `${API}/projects/1`,
        task: `${API}/tasks/1`,
        user: `${API}/users/1`,
      })
    );
    return { data: { [collection]: items } } as never;
  });

  return requests;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FREEAGENT_CLIENT_ID = "test-client";
  process.env.FREEAGENT_CLIENT_SECRET = "test-secret";
  process.env.FREEAGENT_REFRESH_TOKEN = "test-refresh";
});

describe("faGetPaged", () => {
  it("never asks for more than 100 per page, whatever the caller requests", async () => {
    vi.resetModules();
    const requests = mockCollection("invoices", 250);
    const { listInvoices } = await import("../../services/freeagent.js");

    await listInvoices({ limit: 1000 });

    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests) expect(r.perPage).toBeLessThanOrEqual(100);
  });

  it("follows pages until the collection is exhausted", async () => {
    vi.resetModules();
    const requests = mockCollection("invoices", 250);
    const { listInvoices } = await import("../../services/freeagent.js");

    const { items, mayHaveMore } = await listInvoices({ limit: 1000 });

    expect(items).toHaveLength(250);
    expect(mayHaveMore).toBe(false);
    expect(requests.map((r) => r.page)).toEqual([1, 2, 3]);
  });

  it("stops at the caller's limit and flags that more may exist", async () => {
    vi.resetModules();
    mockCollection("invoices", 500);
    const { listInvoices } = await import("../../services/freeagent.js");

    const { items, mayHaveMore } = await listInvoices({ limit: 150 });

    expect(items).toHaveLength(150);
    expect(mayHaveMore).toBe(true);
  });

  it("makes a single request when everything fits on one page", async () => {
    vi.resetModules();
    const requests = mockCollection("invoices", 3);
    const { listInvoices } = await import("../../services/freeagent.js");

    const { items, mayHaveMore } = await listInvoices({ limit: 100 });

    expect(items).toHaveLength(3);
    expect(mayHaveMore).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("copes with an empty collection", async () => {
    vi.resetModules();
    mockCollection("bills", 0);
    const { listBills } = await import("../../services/freeagent.js");

    const { items, mayHaveMore } = await listBills({ limit: 100 });

    expect(items).toEqual([]);
    expect(mayHaveMore).toBe(false);
  });

  it("returns an exact total across pages — the aged-debtors regression", async () => {
    // 250 invoices at £10 each. Reading only the first page reported £1,000
    // and looked entirely plausible.
    vi.resetModules();
    mockCollection("invoices", 250);
    const { listInvoices, buildAgeingBuckets } = await import(
      "../../services/freeagent.js"
    );

    const { items } = await listInvoices({
      view: "open_or_overdue",
      limit: 2000,
    });
    const aged = buildAgeingBuckets(
      items.map((i) => ({
        label: i.contact,
        dueOn: i.due_on,
        dueValue: i.due_value ?? "0",
      })),
      "2026-08-06"
    );

    expect(aged.total).toBe("2500.00");
  });

  it("paginates contacts, so a search does not miss later pages", async () => {
    vi.resetModules();
    mockCollection("contacts", 150);
    const { listContacts } = await import("../../services/freeagent.js");

    const { items } = await listContacts({ limit: 1000 });
    expect(items).toHaveLength(150);
  });

  it("paginates timeslips", async () => {
    vi.resetModules();
    mockCollection("timeslips", 120);
    const { listTimeslips } = await import("../../services/freeagent.js");

    const { items } = await listTimeslips({
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      limit: 1000,
    });
    expect(items).toHaveLength(120);
  });
});

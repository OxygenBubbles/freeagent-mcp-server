/**
 * Payload builders for contacts, invoices, bills, tasks and timeslips,
 * checked against the documented FreeAgent shapes.
 */
import { describe, it, expect } from "vitest";
import {
  buildContactBody,
  buildInvoiceBody,
  buildBillBody,
  buildTaskBody,
  buildTimeslipBody,
  buildAgeingBuckets,
  resolveContactUrl,
  resolveTaskUrl,
} from "../../services/freeagent.js";

const CONTACT = "https://api.freeagent.com/v2/contacts/1";
const USER = "https://api.freeagent.com/v2/users/1";
const PROJECT = "https://api.freeagent.com/v2/projects/1";
const TASK = "https://api.freeagent.com/v2/tasks/1";

describe("buildContactBody", () => {
  it("nests under a 'contact' key and maps to FreeAgent field names", () => {
    const { contact } = buildContactBody({
      organisationName: "Example Client Ltd",
      firstName: "Alex",
      lastName: "Grey",
      email: "user@example.com",
      postcode: "EX1 1EX",
    });
    expect(contact).toEqual({
      organisation_name: "Example Client Ltd",
      first_name: "Alex",
      last_name: "Grey",
      email: "user@example.com",
      postcode: "EX1 1EX",
    });
  });

  it("accepts an organisation with no person", () => {
    expect(buildContactBody({ organisationName: "Acme" }).contact).toEqual({
      organisation_name: "Acme",
    });
  });

  it("rejects a contact with no name at all", () => {
    expect(() => buildContactBody({ email: "user@example.com" })).toThrow(
      /organisation name or a first\/last name/
    );
  });

  it("omits empty strings rather than sending blanks", () => {
    const { contact } = buildContactBody({ organisationName: "Acme", town: "" });
    expect(contact).not.toHaveProperty("town");
  });
});

describe("buildInvoiceBody", () => {
  const base = {
    contactUrl: "/v2/contacts/1",
    datedOn: "2026-08-04",
    paymentTermsInDays: 30,
    items: [
      {
        description: "Consultancy",
        itemType: "Services",
        price: "750.00",
        quantity: "4.0",
        salesTaxRate: "20.0",
        categoryUrl: "/v2/categories/001",
      },
    ],
  };

  it("sends the four required attributes", () => {
    const { invoice } = buildInvoiceBody(base);
    expect(invoice["contact"]).toBe(CONTACT);
    expect(invoice["dated_on"]).toBe("2026-08-04");
    expect(invoice["payment_terms_in_days"]).toBe(30);
    expect(Array.isArray(invoice["invoice_items"])).toBe(true);
  });

  it("numbers line items from 1 and resolves the category URL", () => {
    const { invoice } = buildInvoiceBody({
      ...base,
      items: [base.items[0]!, { ...base.items[0]!, description: "Second" }],
    });
    const items = invoice["invoice_items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => i["position"])).toEqual([1, 2]);
    expect(items[0]!["category"]).toBe("https://api.freeagent.com/v2/categories/001");
    expect(items[0]!["item_type"]).toBe("Services");
    expect(items[0]!["price"]).toBe("750.00");
    expect(items[0]!["quantity"]).toBe("4.0");
    expect(items[0]!["sales_tax_rate"]).toBe("20.0");
  });

  it("omits optional fields when absent", () => {
    const { invoice } = buildInvoiceBody(base);
    for (const key of ["reference", "project", "po_reference", "comments", "discount_percent"]) {
      expect(invoice).not.toHaveProperty(key);
    }
  });

  it("includes optional fields when supplied", () => {
    const { invoice } = buildInvoiceBody({
      ...base,
      reference: "INV-001",
      projectUrl: "/v2/projects/1",
      poReference: "PO-9",
      comments: "Thanks",
      currency: "GBP",
    });
    expect(invoice["reference"]).toBe("INV-001");
    expect(invoice["project"]).toBe(PROJECT);
    expect(invoice["po_reference"]).toBe("PO-9");
    expect(invoice["comments"]).toBe("Thanks");
    expect(invoice["currency"]).toBe("GBP");
  });

  it("rejects an invoice with no line items", () => {
    expect(() => buildInvoiceBody({ ...base, items: [] })).toThrow(/at least one line item/);
  });

  it("rejects nonsensical payment terms", () => {
    expect(() => buildInvoiceBody({ ...base, paymentTermsInDays: -1 })).toThrow(
      /Invalid payment terms/
    );
    expect(() => buildInvoiceBody({ ...base, paymentTermsInDays: 1.5 })).toThrow(
      /Invalid payment terms/
    );
  });

  it("rejects a project URL passed where a contact belongs", () => {
    expect(() => buildInvoiceBody({ ...base, contactUrl: "/v2/projects/1" })).toThrow(
      /Invalid contact/
    );
  });
});

describe("buildBillBody", () => {
  const base = {
    contactUrl: "/v2/contacts/1",
    reference: "INV-2049",
    datedOn: "2026-08-04",
    dueOn: "2026-09-03",
    items: [{ categoryUrl: "/v2/categories/285", totalValue: "120.00", description: "Hotel" }],
  };

  it("matches the documented bill shape", () => {
    const { bill } = buildBillBody(base);
    expect(bill["contact"]).toBe(CONTACT);
    expect(bill["reference"]).toBe("INV-2049");
    expect(bill["dated_on"]).toBe("2026-08-04");
    expect(bill["due_on"]).toBe("2026-09-03");
    expect(bill["bill_items"]).toEqual([
      {
        category: "https://api.freeagent.com/v2/categories/285",
        total_value: "120.00",
        description: "Hotel",
      },
    ]);
  });

  it("attaches a supplier invoice with the documented field names", () => {
    const { bill } = buildBillBody({
      ...base,
      attachment: {
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        fileBase64: "QkFTRTY0",
      },
    });
    expect(bill["attachment"]).toEqual({
      data: "QkFTRTY0",
      file_name: "invoice.pdf",
      content_type: "application/x-pdf",
      description: "invoice.pdf",
    });
  });

  it("rejects an empty or oversized item list", () => {
    expect(() => buildBillBody({ ...base, items: [] })).toThrow(/at least one line item/);
    const many = Array.from({ length: 41 }, () => base.items[0]!);
    expect(() => buildBillBody({ ...base, items: many })).toThrow(/at most 40/);
  });
});

describe("buildTaskBody", () => {
  it("sends project and name, plus billing details when given", () => {
    const { task } = buildTaskBody({
      projectUrl: "/v2/projects/1",
      name: "Delivery workshops",
      isBillable: true,
      billingRate: "850.00",
      billingPeriod: "day",
    });
    expect(task).toEqual({
      project: PROJECT,
      name: "Delivery workshops",
      is_billable: true,
      billing_rate: "850.00",
      billing_period: "day",
    });
  });
});

describe("buildTimeslipBody", () => {
  const base = {
    userUrl: "/v2/users/1",
    projectUrl: "/v2/projects/1",
    taskUrl: "/v2/tasks/1",
    datedOn: "2026-08-04",
    hours: "7.5",
  };

  it("sends the five required attributes as absolute URLs", () => {
    const { timeslip } = buildTimeslipBody(base);
    expect(timeslip).toEqual({
      user: USER,
      project: PROJECT,
      task: TASK,
      dated_on: "2026-08-04",
      hours: "7.5",
    });
  });

  it("includes a comment when supplied", () => {
    const { timeslip } = buildTimeslipBody({ ...base, comment: "Workshop prep" });
    expect(timeslip["comment"]).toBe("Workshop prep");
  });

  it("rejects zero, negative or non-numeric hours", () => {
    for (const hours of ["0", "-1", "abc"]) {
      expect(() => buildTimeslipBody({ ...base, hours })).toThrow(/Invalid hours/);
    }
  });
});

describe("buildAgeingBuckets", () => {
  const today = "2026-08-04";

  it("buckets by days overdue", () => {
    const { buckets } = buildAgeingBuckets(
      [
        { label: "A", dueOn: "2026-09-01", dueValue: "100.00" }, // not yet due
        { label: "B", dueOn: "2026-07-20", dueValue: "200.00" }, // 15 days
        { label: "C", dueOn: "2026-06-20", dueValue: "300.00" }, // 45 days
        { label: "D", dueOn: "2026-05-20", dueValue: "400.00" }, // 76 days
        { label: "E", dueOn: "2026-01-01", dueValue: "500.00" }, // 215 days
      ],
      today
    );
    expect(buckets["not_yet_due"]).toEqual({ count: 1, total: "100.00" });
    expect(buckets["1_30_days"]).toEqual({ count: 1, total: "200.00" });
    expect(buckets["31_60_days"]).toEqual({ count: 1, total: "300.00" });
    expect(buckets["61_90_days"]).toEqual({ count: 1, total: "400.00" });
    expect(buckets["over_90_days"]).toEqual({ count: 1, total: "500.00" });
  });

  it("totals everything outstanding", () => {
    const { total } = buildAgeingBuckets(
      [
        { label: "A", dueOn: "2026-07-01", dueValue: "1200.50" },
        { label: "B", dueOn: "2026-07-02", dueValue: "99.50" },
      ],
      today
    );
    expect(total).toBe("1300.00");
  });

  it("treats an entry due exactly today as not yet overdue", () => {
    const { buckets, items } = buildAgeingBuckets(
      [{ label: "A", dueOn: today, dueValue: "50.00" }],
      today
    );
    expect(buckets["not_yet_due"]!.count).toBe(1);
    expect(items[0]!.daysOverdue).toBe(0);
  });

  it("does not let a missing due date masquerade as 'not yet due'", () => {
    const { buckets, items, unknownDueDateCount } = buildAgeingBuckets(
      [{ label: "A", dueValue: "10.00" }],
      today
    );
    expect(buckets["not_yet_due"]!.count).toBe(0);
    expect(buckets["unknown_due_date"]).toEqual({ count: 1, total: "10.00" });
    expect(items[0]!.daysOverdue).toBeNull();
    expect(unknownDueDateCount).toBe(1);
  });

  it("rejects a malformed outstanding value rather than counting it as zero", () => {
    expect(() =>
      buildAgeingBuckets([{ label: "A", dueOn: "2026-08-01", dueValue: "120.00oops" }], today)
    ).toThrow(/not a number/);
  });

  it("treats an impossible due date as unknown, not as due today", () => {
    const { buckets } = buildAgeingBuckets(
      [{ label: "A", dueOn: "2026-02-31", dueValue: "10.00" }],
      today
    );
    expect(buckets["unknown_due_date"]!.count).toBe(1);
  });

  it("rejects an invalid reporting date", () => {
    expect(() => buildAgeingBuckets([], "not-a-date")).toThrow(/Invalid reporting date/);
  });

  it("sums exactly, without floating-point drift", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point.
    const { total } = buildAgeingBuckets(
      [
        { label: "A", dueOn: "2026-08-01", dueValue: "0.10" },
        { label: "B", dueOn: "2026-08-01", dueValue: "0.20" },
      ],
      today
    );
    expect(total).toBe("0.30");
  });

  it("copes with an empty ledger", () => {
    const { total, items } = buildAgeingBuckets([], today);
    expect(total).toBe("0.00");
    expect(items).toEqual([]);
  });
});

describe("resource resolvers reject cross-type references", () => {
  it("will not accept a task where a contact belongs, or vice versa", () => {
    expect(() => resolveContactUrl("/v2/tasks/1")).toThrow(/Invalid contact/);
    expect(() => resolveTaskUrl("/v2/contacts/1")).toThrow(/Invalid task/);
  });
});

describe("page size ceiling", () => {
  it("never asks FreeAgent for more than 100 records per page", async () => {
    // FreeAgent rejects per_page > 100 with "Records limited to 100 per page".
    const { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } = await import("../../constants.js");
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(100);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});

describe("ageing refuses missing amounts", () => {
  it("throws rather than dropping an invoice with no outstanding value", () => {
    // Silently treating this as £0 is how a real receivable vanishes from a
    // report while the report still looks plausible.
    expect(() =>
      buildAgeingBuckets(
        [{ label: "Acme", reference: "INV-9", dueOn: "2026-08-01", dueValue: undefined }],
        "2026-08-06"
      )
    ).toThrow(/Refusing to treat a missing amount as zero/);
  });
});

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
  buildContactUpdateBody,
  buildInvoiceUpdateBody,
  buildBillUpdateBody,
  buildTaskUpdateBody,
  buildTimeslipUpdateBody,
  buildProjectBody,
  buildProjectUpdateBody,
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

describe("buildContactBody VAT registration", () => {
  it("sends the contact's VAT number and default terms", () => {
    const { contact } = buildContactBody({
      organisationName: "Example Client GmbH",
      salesTaxRegistrationNumber: "DE123456789",
      defaultPaymentTermsInDays: 14,
    });
    expect(contact["sales_tax_registration_number"]).toBe("DE123456789");
    expect(contact["default_payment_terms_in_days"]).toBe(14);
  });

  it("omits them when not supplied", () => {
    const { contact } = buildContactBody({ organisationName: "Example Client Ltd" });
    expect(contact).not.toHaveProperty("sales_tax_registration_number");
    expect(contact).not.toHaveProperty("default_payment_terms_in_days");
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

describe("buildInvoiceBody VAT treatment", () => {
  const base = {
    contactUrl: "/v2/contacts/1",
    datedOn: "2026-08-04",
    paymentTermsInDays: 30,
    items: [
      { description: "Consultancy", itemType: "Services", price: "750.00", quantity: "4.0" },
    ],
  };

  it("omits ec_status unless asked, leaving FreeAgent's UK/Non-EC default", () => {
    const { invoice } = buildInvoiceBody(base);
    expect(invoice).not.toHaveProperty("ec_status");
  });

  it("sends ec_status for a sale to an overseas client", () => {
    const { invoice } = buildInvoiceBody({ ...base, ecStatus: "Reverse Charge" });
    expect(invoice["ec_status"]).toBe("Reverse Charge");
  });

  it("refuses EC VAT MOSS without a place of supply", () => {
    expect(() => buildInvoiceBody({ ...base, ecStatus: "EC VAT MOSS" })).toThrow(
      /placeOfSupply/
    );
  });

  it("sends the place of supply alongside MOSS", () => {
    const { invoice } = buildInvoiceBody({
      ...base,
      ecStatus: "EC VAT MOSS",
      placeOfSupply: "Germany",
    });
    expect(invoice["place_of_supply"]).toBe("Germany");
  });

  it("marks an exempt line", () => {
    const { invoice } = buildInvoiceBody({
      ...base,
      items: [{ ...base.items[0], salesTaxStatus: "EXEMPT" as const }],
    });
    expect((invoice["invoice_items"] as Array<Record<string, unknown>>)[0]["sales_tax_status"])
      .toBe("EXEMPT");
  });
});

describe("buildBillBody VAT treatment", () => {
  const base = {
    contactUrl: "/v2/contacts/1",
    reference: "INV-2049",
    datedOn: "2026-08-04",
    dueOn: "2026-09-03",
    items: [{ categoryUrl: "/v2/categories/285", totalValue: "120.00" }],
  };

  it("omits ec_status unless asked", () => {
    const { bill } = buildBillBody(base);
    expect(bill).not.toHaveProperty("ec_status");
  });

  it("sends ec_status for an overseas supplier", () => {
    const { bill } = buildBillBody({ ...base, ecStatus: "EC Goods" });
    expect(bill["ec_status"]).toBe("EC Goods");
  });

  it("carries quantity, unit and tax status on a line", () => {
    const { bill } = buildBillBody({
      ...base,
      items: [
        {
          categoryUrl: "/v2/categories/285",
          totalValue: "120.00",
          quantity: "2",
          unit: "Hours",
          salesTaxStatus: "OUT_OF_SCOPE" as const,
        },
      ],
    });
    expect((bill["bill_items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      quantity: "2",
      unit: "Hours",
      sales_tax_status: "OUT_OF_SCOPE",
    });
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

describe("buildContactUpdateBody", () => {
  it("updates a single field without needing a name", () => {
    const { contact } = buildContactUpdateBody({ salesTaxRegistrationNumber: "DE123456789" });
    expect(contact).toEqual({ sales_tax_registration_number: "DE123456789" });
  });

  it("hides a contact", () => {
    const { contact } = buildContactUpdateBody({ status: "Hidden" });
    expect(contact["status"]).toBe("Hidden");
  });

  it("renames when a name is given", () => {
    const { contact } = buildContactUpdateBody({ organisationName: "Renamed Ltd" });
    expect(contact["organisation_name"]).toBe("Renamed Ltd");
  });

  it("refuses an empty update", () => {
    expect(() => buildContactUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("buildInvoiceUpdateBody", () => {
  it("sends only what was named", () => {
    const { invoice } = buildInvoiceUpdateBody({ comments: "Chased by phone" });
    expect(invoice).toEqual({ comments: "Chased by phone" });
  });

  it("edits a line by its own url and leaves the rest alone", () => {
    const { invoice } = buildInvoiceUpdateBody({
      items: [{ itemUrl: "/v2/invoice_items/9", price: "800.00" }],
    });
    expect(invoice["invoice_items"]).toEqual([
      { url: "https://api.freeagent.com/v2/invoice_items/9", price: "800.00" },
    ]);
  });

  it("removes a line with _destroy", () => {
    const { invoice } = buildInvoiceUpdateBody({
      items: [{ itemUrl: "/v2/invoice_items/9", destroy: true }],
    });
    expect(invoice["invoice_items"]).toEqual([
      { url: "https://api.freeagent.com/v2/invoice_items/9", _destroy: 1 },
    ]);
  });

  it("refuses to remove a line it cannot address", () => {
    expect(() => buildInvoiceUpdateBody({ items: [{ destroy: true }] })).toThrow(/itemUrl/);
  });

  it("refuses a new line with no description or price", () => {
    expect(() => buildInvoiceUpdateBody({ items: [{ quantity: "1.0" }] })).toThrow(
      /needs both description and price/
    );
  });

  it("rejects a malformed price rather than coercing it", () => {
    expect(() =>
      buildInvoiceUpdateBody({
        items: [{ itemUrl: "/v2/invoice_items/9", price: "750.00x" }],
      })
    ).toThrow();
  });

  it("keeps the MOSS place-of-supply rule", () => {
    expect(() => buildInvoiceUpdateBody({ ecStatus: "EC VAT MOSS" })).toThrow(/placeOfSupply/);
  });

  it("refuses an empty update", () => {
    expect(() => buildInvoiceUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("buildBillUpdateBody", () => {
  it("sets the VAT status alone", () => {
    const { bill } = buildBillUpdateBody({ ecStatus: "Reverse Charge" });
    expect(bill).toEqual({ ec_status: "Reverse Charge" });
  });

  it("adds a new line, edits one and destroys another", () => {
    const { bill } = buildBillUpdateBody({
      items: [
        { categoryUrl: "/v2/categories/285", totalValue: "60.00", description: "Taxi" },
        { itemUrl: "/v2/bill_items/4", totalValue: "75.00" },
        { itemUrl: "/v2/bill_items/5", destroy: true },
      ],
    });
    expect(bill["bill_items"]).toEqual([
      {
        category: "https://api.freeagent.com/v2/categories/285",
        total_value: "60.00",
        description: "Taxi",
      },
      { url: "https://api.freeagent.com/v2/bill_items/4", total_value: "75.00" },
      { url: "https://api.freeagent.com/v2/bill_items/5", _destroy: 1 },
    ]);
  });

  it("refuses a new line missing its category or value", () => {
    expect(() => buildBillUpdateBody({ items: [{ description: "Taxi" }] })).toThrow(
      /needs both categoryUrl and totalValue/
    );
  });

  it("keeps the positive-value rule on an edited line", () => {
    expect(() =>
      buildBillUpdateBody({ items: [{ itemUrl: "/v2/bill_items/4", totalValue: "0.00" }] })
    ).toThrow(/greater than zero/);
  });

  it("refuses an empty update", () => {
    expect(() => buildBillUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("buildTaskUpdateBody", () => {
  it("closes a task", () => {
    const { task } = buildTaskUpdateBody({ status: "Completed" });
    expect(task).toEqual({ status: "Completed" });
  });

  it("keeps a false is_billable rather than dropping it", () => {
    const { task } = buildTaskUpdateBody({ isBillable: false });
    expect(task["is_billable"]).toBe(false);
  });

  it("refuses an empty update", () => {
    expect(() => buildTaskUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("buildTimeslipUpdateBody", () => {
  it("corrects the hours", () => {
    const { timeslip } = buildTimeslipUpdateBody({ hours: "6.25" });
    expect(timeslip).toEqual({ hours: "6.25" });
  });

  it("moves the time to another task", () => {
    const { timeslip } = buildTimeslipUpdateBody({ taskUrl: "/v2/tasks/1" });
    expect(timeslip["task"]).toBe(TASK);
  });

  it("rejects hours that are not a positive number", () => {
    expect(() => buildTimeslipUpdateBody({ hours: "-2" })).toThrow(/Invalid hours/);
  });

  it("allows clearing the comment", () => {
    const { timeslip } = buildTimeslipUpdateBody({ comment: "" });
    expect(timeslip).toEqual({ comment: "" });
  });

  it("refuses an empty update", () => {
    expect(() => buildTimeslipUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("buildProjectBody", () => {
  const base = { contactUrl: "/v2/contacts/1", name: "Example Client Ltd — Q3" };

  it("fills in the attributes FreeAgent requires", () => {
    const { project } = buildProjectBody(base);
    expect(project).toEqual({
      contact: CONTACT,
      name: "Example Client Ltd — Q3",
      currency: "GBP",
      budget: 0,
      budget_units: "Hours",
      status: "Active",
      uses_project_invoice_sequence: false,
    });
  });

  it("carries the optional engagement details", () => {
    const { project } = buildProjectBody({
      ...base,
      budget: 20000,
      budgetUnits: "Monetary",
      normalBillingRate: "650.00",
      billingPeriod: "day",
      isIr35: false,
      startsOn: "2026-09-01",
      contractPoReference: "PO-4471",
    });
    expect(project).toMatchObject({
      budget: 20000,
      budget_units: "Monetary",
      normal_billing_rate: "650.00",
      billing_period: "day",
      is_ir35: false,
      starts_on: "2026-09-01",
      contract_po_reference: "PO-4471",
    });
  });

  it("rejects a cross-type reference for the contact", () => {
    expect(() => buildProjectBody({ ...base, contactUrl: "/v2/projects/1" })).toThrow();
  });

  it("needs a name", () => {
    expect(() => buildProjectBody({ contactUrl: "/v2/contacts/1", name: "  " })).toThrow(
      /needs a name/
    );
  });
});

describe("buildProjectUpdateBody", () => {
  it("closes a project without touching its budget", () => {
    const { project } = buildProjectUpdateBody({ status: "Completed" });
    expect(project).toEqual({ status: "Completed" });
  });

  it("keeps a zero budget rather than dropping it", () => {
    const { project } = buildProjectUpdateBody({ budget: 0 });
    expect(project).toEqual({ budget: 0 });
  });

  it("refuses an empty update", () => {
    expect(() => buildProjectUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe("clearing optional contact fields", () => {
  it("drops a blank on create — a blank field is noise, not an instruction", () => {
    const { contact } = buildContactBody({ organisationName: "Acme", town: "" });
    expect(contact).not.toHaveProperty("town");
  });

  it("clears the same field on update, where a blank means 'remove this'", () => {
    const { contact } = buildContactUpdateBody({ salesTaxRegistrationNumber: "" });
    expect(contact).toEqual({ sales_tax_registration_number: null });
  });

  it("never sends the internal clearEmpty flag to FreeAgent", () => {
    const { contact } = buildContactUpdateBody({ town: "Sometown" });
    expect(contact).not.toHaveProperty("clearEmpty");
  });
});

describe("line item URLs are validated by collection", () => {
  it("rejects a bill item URL passed as an invoice line", () => {
    expect(() =>
      buildInvoiceUpdateBody({ items: [{ itemUrl: "/v2/bill_items/9", destroy: true }] })
    ).toThrow();
  });

  it("rejects an invoice item URL passed as a bill line", () => {
    expect(() =>
      buildBillUpdateBody({ items: [{ itemUrl: "/v2/invoice_items/9", destroy: true }] })
    ).toThrow();
  });
});

/**
 * The POST /v2/expenses payload, checked against the documented shape:
 * https://dev.freeagent.com/docs/expenses
 */
import { describe, it, expect } from "vitest";
import {
  buildExpenseBody,
  buildMileageExpenseBody,
  toAbsoluteUrl,
  resolveCategoryUrl,
  resolveProjectUrl,
  toExpenseClaimValue,
} from "../../services/freeagent.js";

const USER = "https://api.freeagent.com/v2/users/1";

const base = {
  categoryUrl: "/v2/categories/285",
  datedOn: "2026-04-15",
  description: "Example Vendor — Hotel",
  grossValue: "84.50",
  userUrl: USER,
};

describe("toAbsoluteUrl", () => {
  it("does not duplicate the /v2 segment already in the API base", () => {
    expect(toAbsoluteUrl("/v2/categories/285")).toBe(
      "https://api.freeagent.com/v2/categories/285"
    );
  });

  it("accepts a path without the /v2 prefix", () => {
    expect(toAbsoluteUrl("/categories/285")).toBe(
      "https://api.freeagent.com/v2/categories/285"
    );
  });

  it("passes an absolute URL through unchanged", () => {
    const url = "https://api.freeagent.com/v2/categories/285";
    expect(toAbsoluteUrl(url)).toBe(url);
  });
});

describe("resolveCategoryUrl / resolveProjectUrl", () => {
  it("accepts both the path and full-URL forms", () => {
    expect(resolveCategoryUrl("/v2/categories/365")).toBe(
      "https://api.freeagent.com/v2/categories/365"
    );
    expect(resolveCategoryUrl("https://api.freeagent.com/v2/categories/365")).toBe(
      "https://api.freeagent.com/v2/categories/365"
    );
    expect(resolveProjectUrl("/v2/projects/123")).toBe(
      "https://api.freeagent.com/v2/projects/123"
    );
  });

  it("rejects anything that is not a category/project reference", () => {
    expect(() => resolveCategoryUrl("/v2/projects/1")).toThrow(/Invalid category/);
    expect(() => resolveCategoryUrl("nonsense")).toThrow(/Invalid category/);
    expect(() => resolveProjectUrl("/v2/categories/1")).toThrow(/Invalid project/);
  });
});

describe("toExpenseClaimValue", () => {
  it("negates a positive amount — a claim is money owed to the claimant", () => {
    expect(toExpenseClaimValue("84.50")).toBe("-84.50");
  });

  it("leaves an already-negative amount alone", () => {
    expect(toExpenseClaimValue("-84.50")).toBe("-84.50");
  });

  it("rejects a non-numeric amount", () => {
    expect(() => toExpenseClaimValue("abc")).toThrow(/Invalid gross amount/);
  });
});

describe("buildExpenseBody", () => {
  it("nests everything under an 'expense' key", () => {
    expect(Object.keys(buildExpenseBody(base))).toEqual(["expense"]);
  });

  it("always sends the required user URL — FreeAgent rejects a blank user", () => {
    expect(buildExpenseBody(base).expense["user"]).toBe(USER);
  });

  it("sends the category as an absolute URL with a single /v2", () => {
    expect(buildExpenseBody(base).expense["category"]).toBe(
      "https://api.freeagent.com/v2/categories/285"
    );
  });

  it("uses the documented field names", () => {
    const { expense } = buildExpenseBody(base);
    expect(expense["dated_on"]).toBe("2026-04-15");
    expect(expense["gross_value"]).toBe("-84.50");
    expect(expense["description"]).toBe("Example Vendor — Hotel");
    expect(expense["currency"]).toBe("GBP");
  });

  it("omits optional fields when not supplied", () => {
    const { expense } = buildExpenseBody(base);
    expect(expense).not.toHaveProperty("project");
    expect(expense).not.toHaveProperty("attachment");
    expect(expense).not.toHaveProperty("sales_tax_rate");
    expect(expense).not.toHaveProperty("manual_sales_tax_amount");
  });

  it("includes the project URL when tagging to a client engagement", () => {
    const { expense } = buildExpenseBody({ ...base, projectUrl: "/v2/projects/123" });
    expect(expense["project"]).toBe("https://api.freeagent.com/v2/projects/123");
  });

  it("passes sales tax fields through", () => {
    const { expense } = buildExpenseBody({
      ...base,
      salesTaxRate: "20.0",
      manualSalesTaxAmount: "16.07",
    });
    expect(expense["sales_tax_rate"]).toBe("20.0");
    expect(expense["manual_sales_tax_amount"]).toBe("16.07");
  });

  it("nests the attachment with FreeAgent's field names and PDF MIME type", () => {
    const { expense } = buildExpenseBody({
      ...base,
      attachment: {
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        fileBase64: "QkFTRTY0",
      },
    });
    expect(expense["attachment"]).toEqual({
      data: "QkFTRTY0",
      file_name: "receipt.pdf",
      content_type: "application/x-pdf",
      description: "receipt.pdf",
    });
  });

  it("leaves non-PDF MIME types untouched", () => {
    const { expense } = buildExpenseBody({
      ...base,
      attachment: {
        fileName: "receipt.png",
        contentType: "image/png",
        fileBase64: "QkFTRTY0",
      },
    });
    expect((expense["attachment"] as { content_type: string }).content_type).toBe(
      "image/png"
    );
  });

  it("matches the documented example payload shape", () => {
    const { expense } = buildExpenseBody({
      categoryUrl: "/v2/categories/285",
      datedOn: "2011-08-24",
      description: "Some description",
      grossValue: "12.0",
      userUrl: "https://api.freeagent.com/v2/users/1",
      salesTaxRate: "20.0",
      manualSalesTaxAmount: "0.12",
    });
    expect(expense).toEqual({
      user: "https://api.freeagent.com/v2/users/1",
      category: "https://api.freeagent.com/v2/categories/285",
      dated_on: "2011-08-24",
      description: "Some description",
      gross_value: "-12.00",
      currency: "GBP",
      sales_tax_rate: "20.0",
      manual_sales_tax_amount: "0.12",
    });
  });
});

describe("buildMileageExpenseBody", () => {
  const mileageBase = {
    userUrl: USER,
    categoryUrl: "/v2/categories/249",
    datedOn: "2026-04-15",
    description: "Site visit",
    miles: 84,
    vehicleType: "Car" as const,
  };

  it("sends mileage and vehicle_type, which the Mileage category requires", () => {
    const { expense } = buildMileageExpenseBody(mileageBase);
    expect(expense["mileage"]).toBe(84);
    expect(expense["vehicle_type"]).toBe("Car");
    expect(expense["reclaim_mileage"]).toBe(1);
  });

  it("never sends gross_value — FreeAgent calculates it from the mileage rate", () => {
    const { expense } = buildMileageExpenseBody(mileageBase);
    expect(expense).not.toHaveProperty("gross_value");
  });

  it("resolves the category to an absolute URL with a single /v2", () => {
    const { expense } = buildMileageExpenseBody(mileageBase);
    expect(expense["category"]).toBe("https://api.freeagent.com/v2/categories/249");
    expect(expense["user"]).toBe(USER);
  });

  it("tags the journey to a project when asked", () => {
    const { expense } = buildMileageExpenseBody({
      ...mileageBase,
      projectUrl: "/v2/projects/123",
      rebillType: "cost",
    });
    expect(expense["project"]).toBe("https://api.freeagent.com/v2/projects/123");
    expect(expense["rebill_type"]).toBe("cost");
  });
});

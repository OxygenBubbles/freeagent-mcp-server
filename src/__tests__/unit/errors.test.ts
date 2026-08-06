/**
 * FreeAgent validation messages must reach the caller verbatim.
 *
 * Regression: an array of {message} objects used to render as
 * "[object Object], [object Object], [object Object]".
 */
import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import { extractFreeAgentErrors, handleFAError } from "../../services/freeagent.js";

function axios422(data: unknown): AxiosError {
  const err = new AxiosError("Request failed with status code 422");
  err.response = {
    status: 422,
    statusText: "Unprocessable Entity",
    data,
    headers: {},
    config: {} as never,
  };
  return err;
}

describe("extractFreeAgentErrors", () => {
  it("extracts messages from the documented array-of-objects shape", () => {
    expect(
      extractFreeAgentErrors({
        errors: [
          { message: "user can't be blank" },
          { message: "Exchange rates for this transaction are not known" },
          { message: "category can't be blank" },
        ],
      })
    ).toEqual([
      "user can't be blank",
      "Exchange rates for this transaction are not known",
      "category can't be blank",
    ]);
  });

  it("handles a single nested error object", () => {
    expect(
      extractFreeAgentErrors({ errors: { error: { message: "Invalid category" } } })
    ).toEqual(["Invalid category"]);
  });

  it("labels field-keyed errors with the field name", () => {
    expect(
      extractFreeAgentErrors({ errors: { dated_on: ["is not a valid date"] } })
    ).toEqual(["dated_on: is not a valid date"]);
  });

  it("handles a plain string error", () => {
    expect(extractFreeAgentErrors({ errors: "Something went wrong" })).toEqual([
      "Something went wrong",
    ]);
  });

  it("reads the OAuth error_description shape", () => {
    expect(
      extractFreeAgentErrors({
        error: "invalid_grant",
        error_description: "The refresh token is invalid",
      })
    ).toContain("The refresh token is invalid");
  });

  it("de-duplicates repeated messages", () => {
    expect(
      extractFreeAgentErrors({ errors: [{ message: "same" }, { message: "same" }] })
    ).toEqual(["same"]);
  });

  it("returns nothing for an empty body", () => {
    expect(extractFreeAgentErrors({})).toEqual([]);
    expect(extractFreeAgentErrors(null)).toEqual([]);
  });
});

describe("handleFAError", () => {
  it("surfaces all three validation messages, not [object Object]", () => {
    const text = handleFAError(
      axios422({
        errors: [
          { message: "user can't be blank" },
          { message: "category can't be blank" },
        ],
      })
    );
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("user can't be blank");
    expect(text).toContain("category can't be blank");
  });

  it("falls back to generic advice when the body carries no messages", () => {
    expect(handleFAError(axios422({}))).toContain("Check the data you supplied");
  });

  it("does not leak credentials on a 401", () => {
    const err = new AxiosError("Unauthorized");
    err.response = {
      status: 401,
      statusText: "Unauthorized",
      data: { errors: [{ message: "Access token is invalid" }] },
      headers: {},
      config: {} as never,
    };
    const text = handleFAError(err);
    expect(text).toContain("authentication failed");
  });
});

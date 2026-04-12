import { describe, it, expect } from "vitest";
import { inferContentType } from "../../utils/contentType.js";

describe("inferContentType", () => {
  it.each([
    ["receipt.pdf",     "application/pdf"],
    ["photo.png",       "image/png"],
    ["photo.jpg",       "image/jpeg"],
    ["photo.jpeg",      "image/jpeg"],
    ["image.gif",       "image/gif"],
    ["image.webp",      "image/webp"],
    ["photo.heic",      "image/heic"],
    ["scan.tiff",       "image/tiff"],
    ["scan.tif",        "image/tiff"],
  ])("%s → %s", (fileName, expected) => {
    expect(inferContentType(fileName)).toBe(expected);
  });

  it("handles uppercase extensions", () => {
    expect(inferContentType("RECEIPT.PDF")).toBe("application/pdf");
    expect(inferContentType("PHOTO.PNG")).toBe("image/png");
  });

  it("handles files with multiple dots", () => {
    expect(inferContentType("invoice.2026.04.12.pdf")).toBe("application/pdf");
  });

  it("returns octet-stream for unknown extension", () => {
    expect(inferContentType("archive.docx")).toBe("application/octet-stream");
    expect(inferContentType("file.xyz")).toBe("application/octet-stream");
  });

  it("returns octet-stream when there is no extension", () => {
    expect(inferContentType("README")).toBe("application/octet-stream");
  });
});

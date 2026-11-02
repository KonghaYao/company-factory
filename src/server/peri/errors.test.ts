import { describe, expect, test } from "bun:test";
import { RuntimeError } from "../../runtime";
import { publicErrorDetails, runtimeErrorBody } from "./errors";

describe("public error mapping", () => {
  test("known runtime codes use the fixed Chinese copy", () => {
    const error = new RuntimeError(
      "input_receipt_capacity",
      "Input receipt capacity is occupied by pending or uncertain admissions; no new input was sent.",
      503,
      { disposition: "not_sent", recovery: "none" },
    );
    const mapped = runtimeErrorBody(error, {});
    expect(mapped.status).toBe(503);
    expect(String(mapped.body.message)).toMatch(/[\u4e00-\u9fa5]/);
    expect(String(mapped.body.message)).not.toContain("Input receipt");
    // details 的 disposition 是权威，哪怕与 definition 不同。
    expect(mapped.body.disposition).toBe("not_sent");
  });

  test("unknown codes fall back to a publicly redacted message", () => {
    const error = new RuntimeError(
      "wasm_activation_failed",
      "connect https://secret.invalid/db?token=SUPERSECRET1234567890 failed",
      500,
    );
    const mapped = runtimeErrorBody(error, {});
    expect(String(mapped.body.message)).not.toContain("secret.invalid");
    expect(String(mapped.body.message)).not.toContain("SUPERSECRET1234567890");
    expect(String(mapped.body.message)).toContain("[url]");
  });

  test("global error details keep scalars only and redact sensitive keys", () => {
    expect(publicErrorDetails({
      token: "SHORT",
      apiKey: "SHORT",
      stage: "bind",
      count: 2,
      ok: false,
      missing: null,
      note: "auth failed for SUPERSECRET1234567890 at https://secret.invalid",
      nested: { token: "SHORT" },
      list: ["x"],
    })).toEqual({
      token: "[redacted]",
      apiKey: "[redacted]",
      stage: "bind",
      count: 2,
      ok: false,
      missing: null,
      note: "auth failed for [redacted] at [url]",
    });
    expect(publicErrorDetails(null)).toBeUndefined();
    expect(publicErrorDetails(["x"])).toBeUndefined();
    expect(publicErrorDetails({})).toBeUndefined();
  });
});

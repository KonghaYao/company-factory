import { expect, test } from "bun:test";
import { redactPublicMessage, redactRuntimeMessage } from "./redaction";

test("URLs are replaced without leaking hosts or credentials", () => {
  for (const message of [
    "request to https://api.example.test/v1?token=secret failed",
    "connect libsql://user:pass@host.example/db refused",
    "postgres://user:pass@db.internal:5432/app is down",
  ]) {
    const redacted = redactRuntimeMessage(message);
    expect(redacted).toContain("[url]");
    expect(redacted).not.toContain("api.example.test");
    expect(redacted).not.toContain("host.example");
    expect(redacted).not.toContain("db.internal");
    expect(redacted).not.toContain("user:pass");
  }
});

test("32+ character tokens are redacted in free text", () => {
  const token = "0123456789abcdef0123456789abcdef01234567";
  const redacted = redactRuntimeMessage(`upstream rejected ${token}`);
  expect(redacted).toContain("[redacted]");
  expect(redacted).not.toContain(token);
});

test("Authorization, token, api_key and password values never survive", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"],
    ["token=supersecret012345678901234567890123456789", "supersecret012345678901234567890123456789"],
    ["api_key=abcdef0123456789abcdef0123456789", "abcdef0123456789abcdef0123456789"],
    ["password=hunter2hunter2hunter2", "hunter2hunter2hunter2"],
  ] as const;
  for (const [message, secret] of cases) {
    const redacted = redactRuntimeMessage(message);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(secret);
  }
});

test("length limits are applied without touching ordinary text", () => {
  expect(redactRuntimeMessage("database is locked")).toBe("database is locked");
  const longText = "word ".repeat(200).trim();
  expect(redactRuntimeMessage(longText).length).toBeLessThanOrEqual(241);
  expect(redactRuntimeMessage(longText, 500).length).toBe(501);
});

test("public messages also redact bare short tokens without a key prefix", () => {
  const token = "SUPERSECRET1234567890";
  expect(redactRuntimeMessage(`auth failed for ${token}`)).toContain(token);
  const redacted = redactPublicMessage(`auth failed for ${token}`);
  expect(redacted).toContain("[redacted]");
  expect(redacted).not.toContain(token);
  expect(redactPublicMessage("database is locked")).toBe("database is locked");
});

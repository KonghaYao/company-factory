import { test, expect } from "bun:test";
import { uuid } from "./uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuid works on LAN HTTP where randomUUID is unavailable", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  try {
    expect(uuid()).toMatch(UUID_V4);
    expect(uuid()).not.toBe(uuid());
  } finally {
    delete (globalThis.crypto as any).randomUUID;
  }
});

test("uuid prefers the platform randomUUID when available", () => {
  expect(uuid()).toMatch(UUID_V4);
});

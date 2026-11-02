import { describe, expect, test } from "bun:test";
import {
  InputReceiptCache,
  PROMPT_ADMIT_WINDOW_MS,
  withinAdmissionWindow,
} from "./input-receipts";

describe("bounded input admission receipts", () => {
  test("concurrent replay shares one admission and a conflicting body never submits", async () => {
    const cache = new InputReceiptCache<number>();
    let resolve!: (value: number) => void;
    const gate = new Promise<number>((done) => { resolve = done; });
    let calls = 0;
    const submit = () => { calls++; return gate; };
    const one = cache.run("request", "digest", submit);
    const two = cache.run("request", "digest", submit);
    expect(two).toBe(one);
    expect(() => cache.run("request", "other", submit)).toThrow("different content");
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve(7);
    expect(await two).toBe(7);
    expect(await cache.run("request", "digest", submit)).toBe(7);
    expect(calls).toBe(1);
  });

  test("definite non-admissions can retry the same ID; unknown admissions cannot", async () => {
    for (const disposition of ["not_sent", "rejected"]) {
      const cache = new InputReceiptCache<number>();
      await expect(cache.run("request", "digest", async () => {
        throw { details: { disposition } };
      })).rejects.toMatchObject({ details: { disposition } });
      expect(cache.size).toBe(0);
      expect(await cache.run("request", "digest", async () => 9)).toBe(9);
    }
    const cache = new InputReceiptCache<number>();
    let calls = 0;
    const submit = async () => { calls++; throw { details: { disposition: "unknown" } }; };
    await expect(cache.run("request", "digest", submit)).rejects.toMatchObject({ details: { disposition: "unknown" } });
    await expect(cache.run("request", "digest", submit)).rejects.toMatchObject({ details: { disposition: "unknown" } });
    expect(calls).toBe(1);
  });

  test("expiry and pressure release accepted receipts, while pending and unknown stay pinned", async () => {
    let time = 0;
    const cache = new InputReceiptCache<number>({ limit: 3, ttlMs: 10, now: () => time });
    let finish!: (value: number) => void;
    const pending = cache.run("pending", "p", () => new Promise<number>((done) => { finish = done; }));
    await expect(cache.run("unknown", "u", async () => { throw new Error("lost response"); })).rejects.toThrow("lost response");
    await cache.run("old", "a", async () => 1);
    await cache.run("new", "b", async () => 2);
    expect(cache.size).toBe(3);
    time = 20;
    await cache.run("another", "c", async () => 3);
    expect(cache.size).toBe(3);
    let forbidden = 0;
    const thirdPending = cache.run("third-pending", "d", () => new Promise<number>(() => {}));
    expect(() => cache.run("overflow", "e", async () => ++forbidden)).toThrow("no new input was sent");
    expect(forbidden).toBe(0);
    expect(cache.run("pending", "p", async () => 99)).toBe(pending);
    await expect(cache.run("unknown", "u", async () => 99)).rejects.toThrow("lost response");
    finish(8);
    expect(await pending).toBe(8);
    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
    void thirdPending;
  });

  test("pendingCount counts only unsettled admissions and honors a scope prefix", async () => {
    const cache = new InputReceiptCache<number>();
    let finishA!: (value: number) => void;
    let finishB!: (value: number) => void;
    const a = cache.run(
      "c-1/dev-1/request-a",
      "a",
      () => new Promise<number>((done) => { finishA = done; }),
    );
    const b = cache.run(
      "c-1/dev-2/request-b",
      "b",
      () => new Promise<number>((done) => { finishB = done; }),
    );
    await cache.run("c-2/dev-1/request-c", "c", async () => 3);
    await expect(
      cache.run("c-1/dev-1/request-d", "d", async () => {
        throw { details: { disposition: "unknown" } };
      }),
    ).rejects.toMatchObject({ details: { disposition: "unknown" } });

    expect(cache.pendingCount()).toBe(2);
    expect(cache.pendingCount("c-1/dev-1/")).toBe(1);
    expect(cache.pendingCount("c-2/")).toBe(0);
    finishA(1);
    finishB(2);
    await Promise.all([a, b]);
    expect(cache.pendingCount()).toBe(0);
    expect(cache.pendingCount("c-1/")).toBe(0);
  });

  test("direct prompt admission window is 750ms by contract", () => {
    expect(PROMPT_ADMIT_WINDOW_MS).toBe(750);
  });

  test("window observes success/rejection but leaves a long prompt open", async () => {
    const settled = await withinAdmissionWindow(Promise.resolve(7), 20);
    expect(settled).toEqual({ state: "settled", value: 7 });

    const rejected = await withinAdmissionWindow(
      Promise.reject({ details: { disposition: "rejected" } }),
      20,
    );
    expect(rejected).toMatchObject({ state: "rejected" });

    let rejectLate!: (error: unknown) => void;
    const late = new Promise<never>((_, reject) => { rejectLate = reject; });
    const open = await withinAdmissionWindow(late, 5);
    expect(open).toEqual({ state: "open" });
    // 窗口先到后仍安装拒绝处理器；这里只验证不会产生未处理的 rejection。
    rejectLate(new Error("late failure"));
    await Promise.resolve();
  });
});

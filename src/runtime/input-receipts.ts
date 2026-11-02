/**
 * Process-local input admission receipts, not a work scheduler or durable queue.
 * Accepted receipts are a bounded replay window. Pending/unknown admissions stay
 * pinned: capacity pressure must never silently turn uncertainty into a resend.
 */
export const INPUT_RECEIPT_LIMIT = 1024;
export const INPUT_RECEIPT_TTL_MS = 30 * 60 * 1000;

/**
 * direct `session/prompt` 的同步受理窗口。
 *
 * 窗口内同步失败 → HTTP 错误；窗口外仍可返回 202，失败通过 runtime
 * snapshot 的 `promptFailure` 异步投影。整轮 RPC 不阻塞 HTTP。
 */
export const PROMPT_ADMIT_WINDOW_MS = 750;

export type AdmissionWindowOutcome<T> =
  | { state: "settled"; value: T }
  | { state: "rejected"; error: unknown }
  | { state: "open" };

/**
 * 在受理窗口内观察一个整轮 RPC。
 *
 * 始终为被观察的 promise 安装拒绝处理器：即使窗口先到，后续失败也不会成为
 * unhandled rejection；调用方仍可自行在后台记录失败。
 */
export async function withinAdmissionWindow<T>(
  work: Promise<T>,
  windowMs = PROMPT_ADMIT_WINDOW_MS,
): Promise<AdmissionWindowOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = work.then(
    (value): AdmissionWindowOutcome<T> => ({ state: "settled", value }),
    (error): AdmissionWindowOutcome<T> => ({ state: "rejected", error }),
  );
  const opened = new Promise<AdmissionWindowOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ state: "open" }), Math.max(0, windowMs));
  });
  try {
    return await Promise.race([observed, opened]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class InputReceiptCacheError extends Error {
  constructor(readonly code: "idempotency_conflict" | "input_receipt_capacity") {
    super(code === "idempotency_conflict"
      ? "The same input request ID was used with different content."
      : "Input receipt capacity is occupied by pending or uncertain admissions; no new input was sent.");
  }
}

interface Entry<T> {
  fingerprint: string;
  result: Promise<T>;
  state: "pending" | "accepted" | "unknown";
  expiresAt: number;
}

function definitelyNotAccepted(error: unknown): boolean {
  const value = error as { disposition?: unknown; details?: { disposition?: unknown } } | null;
  const disposition = value?.details?.disposition ?? value?.disposition;
  return disposition === "not_sent" || disposition === "rejected";
}

export class InputReceiptCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly limit: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(options: { limit?: number; ttlMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? INPUT_RECEIPT_LIMIT;
    this.ttl = options.ttlMs ?? INPUT_RECEIPT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.ttl <= 0)
      throw new Error("Input receipt cache requires a positive limit and lifetime");
  }

  get size(): number { return this.entries.size; }

  run(key: string, fingerprint: string, submit: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [id, entry] of this.entries)
      if (entry.state === "accepted" && entry.expiresAt <= now) this.entries.delete(id);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new InputReceiptCacheError("idempotency_conflict");
      this.entries.delete(key);
      this.entries.set(key, previous);
      return previous.result;
    }
    while (this.entries.size >= this.limit) {
      const oldestAccepted = [...this.entries].find(([, entry]) => entry.state === "accepted");
      if (!oldestAccepted) throw new InputReceiptCacheError("input_receipt_capacity");
      this.entries.delete(oldestAccepted[0]);
    }
    const entry: Entry<T> = {
      fingerprint, state: "pending", expiresAt: Infinity,
      result: undefined as unknown as Promise<T>,
    };
    // Publish before invoking submit, including when submit throws synchronously.
    this.entries.set(key, entry);
    entry.result = Promise.resolve().then(submit).then(
      (value) => {
        entry.state = "accepted";
        entry.expiresAt = this.now() + this.ttl;
        return value;
      },
      (error) => {
        if (definitelyNotAccepted(error)) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
        } else entry.state = "unknown";
        throw error;
      },
    );
    return entry.result;
  }

  /** Only after the owning runtime has fully shut down. */
  clear(): void { this.entries.clear(); }
}

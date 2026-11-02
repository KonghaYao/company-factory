import { join } from "node:path";
import { CompanyStore, digest, safeId } from "../storage/company-store";
import { now, requireValue, type CallerContext } from "./types";

/**
 * A prepared request is a durable result, not a successful operation yet.
 * Its exact blob in the Company Git HEAD is the completion proof. Deriving
 * completion from Git avoids a second marker commit and its own failure window.
 * The caller owns the Company lock and authentication; this module never runs
 * business decisions, dispatches work, or retries the business mutation.
 */
export async function completeMutation<T>(options: {
  store: CompanyStore;
  caller: CallerContext;
  operation: string;
  input: Record<string, unknown>;
  run(): Promise<T>;
  changed(): void;
}): Promise<T> {
  const { store, caller, operation, input } = options;
  const requestId = safeId(
    input.requestId,
    "requestId (required for mutations)",
  );
  const company = store.company(caller.companyId);
  const requestPath = join(
    company,
    "events",
    "requests",
    `${digest(`${caller.type}:${caller.id}:${operation}:${requestId}`)}.yaml`,
  );
  const requestHash = digest(input);
  let result: T;
  if (await store.exists(requestPath)) {
    const prepared = await store.yaml(requestPath);
    requireValue(
      prepared.hash === requestHash,
      "idempotency_conflict",
      "Request ID was already used with different input",
      409,
    );
    result = prepared.result as T;
  } else {
    result = await options.run();
    await store.putYaml(requestPath, {
      operation,
      actor: caller.id,
      request_id: requestId,
      hash: requestHash,
      at: now(),
      // The record is complete only once these bytes are committed to Git.
      completion: "git",
      result,
    });
  }
  if (!(await store.isCommittedFile(company, requestPath))) {
    await store.commit(company, `${operation} by ${caller.type}:${caller.id}`);
    requireValue(
      await store.isCommittedFile(company, requestPath),
      "commit_incomplete",
      "Company mutation result has not been committed; retry the same request",
      503,
    );
  }
  // Resource invalidation is idempotent. Replay also republishes it, covering
  // commit success followed by an interrupted notification without redoing work.
  options.changed();
  return result;
}

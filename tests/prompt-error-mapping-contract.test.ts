import { describe, expect, test } from "bun:test";
import {
  PROMPT_ERROR_CODES,
  promptErrorDefinition,
} from "../src/runtime/prompt-errors";
import {
  failureMessageForCode,
  failureRecoveryForCode,
} from "../web/src/peri/remote/view-state";

/**
 * 服务端与 web 的错误表必须保持单向覆盖：服务端能产出的每个 code，
 * web 都必须有中文文案与相同 recovery，避免新 code 被降级为 unknown/none。
 */
describe("prompt error mapping contract", () => {
  test("every server code has a web copy and matching recovery", () => {
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const code of PROMPT_ERROR_CODES) {
      const definition = promptErrorDefinition(code)!;
      const message = failureMessageForCode(code);
      if (!message || message.length === 0) missing.push(code);
      const recovery = failureRecoveryForCode(code);
      if (recovery !== definition.recovery)
        mismatched.push(`${code}: server=${definition.recovery} web=${recovery}`);
    }
    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });
});

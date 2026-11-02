import { redactRuntimeMessage } from "../../runtime/redaction";

/**
 * 诊断日志出口。server 与 frontend 是两个独立进程，不共享运行时；
 * 这层 3 行 `console.error` 包装允许两侧各一份，不引入公共包。
 *
 * 上游 error 可能把用户正文、URL 或凭据放进 message/stack；只输出经过
 * redactRuntimeMessage 的文本，不再打印原始对象。
 */
export function logError(label: string, error: unknown, context: Record<string, unknown> = {}): void {
  const message = redactRuntimeMessage(
    error instanceof Error ? error.message : String(error),
  );
  // stack 仅用于本地诊断；同样先脱敏并限制长度。
  const stack = error instanceof Error && error.stack
    ? redactRuntimeMessage(error.stack, 2000)
    : undefined;
  console.error(label, context, message, ...(stack ? [stack] : []));
}

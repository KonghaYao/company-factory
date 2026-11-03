import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { TodoStatus } from "../../../lib/types";
import { todoStatusLabels } from "../../../lib/taskProgress";

const icons = {
  pending: Circle,
  in_progress: CircleDot,
  done: CircleCheck,
} as const;

/** 待办状态统一为「图标 + 文案」；文案承载无障碍语义，图标仅装饰。 */
export function TodoStatusText({ status }: { status: TodoStatus }) {
  const Icon = icons[status] ?? Circle;
  return (
    <span
      className="todo-status-text"
      data-testid="todo-status"
      data-status={status}
    >
      <Icon size={12} aria-hidden="true" />
      {todoStatusLabels[status] ?? status}
    </span>
  );
}

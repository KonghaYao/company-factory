import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListOrdered, Undo2, FastForward } from "lucide-react";
import { post, scoped } from "../lib/api";
import type { Scope, Runtime } from "../lib/types";
import { ErrorBox } from "./Common";
export function InputQueue({
  scope,
  runtime,
}: {
  scope: Scope;
  runtime: Runtime;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      operation,
      inputId,
    }: {
      operation: string;
      inputId: string;
    }) =>
      post(scoped(scope, `queue/${operation}`), {
        companyId: scope.companyId,
        inputId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["runtime", scope.companyId, scope.agentId],
      });
      qc.invalidateQueries({
        queryKey: ["chat", scope.companyId, scope.agentId],
      });
    },
  });
  if (!runtime.capabilities?.queue || !runtime.queue?.length) return null;
  return (
    <details className="input-queue" open>
      <summary>
        <ListOrdered size={13} />
        Peri 输入队列 <span>{runtime.queue.length}</span>
      </summary>
      {runtime.queue.map((item) => (
        <div className="queue-item" key={item.inputId}>
          <code title={item.inputId}>{item.inputId}</code>
          <span>{item.state}</span>
          {runtime.capabilities?.queueTakeBack && (
            <button
              className="icon-button"
              title="从 Peri 队列取回，不停止当前回复"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  operation: "take-back",
                  inputId: item.inputId,
                })
              }
            >
              <Undo2 size={12} />
            </button>
          )}
          {runtime.capabilities?.queueForceSend && (
            <button
              className="icon-button"
              title="使用 Peri 原生立即投递"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  operation: "force-send",
                  inputId: item.inputId,
                })
              }
            >
              <FastForward size={12} />
            </button>
          )}
        </div>
      ))}
      <ErrorBox error={mutation.error} />
    </details>
  );
}

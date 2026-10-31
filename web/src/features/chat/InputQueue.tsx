import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FastForward, ListOrdered, Undo2 } from "lucide-react";
import { post, scoped } from "../../lib/api";
import type { Runtime, Scope } from "../../lib/types";
import { ErrorBox, IconButton } from "../../ui/primitives";

/** Peri 输入队列的只读投影 + 两个原生操作。 */
export function InputQueue({
  scope,
  runtime,
}: {
  scope: Scope;
  runtime?: Runtime;
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
  if (!runtime?.capabilities?.queue || !runtime.queue?.length) return null;

  return (
    <details className="input-queue" open>
      <summary>
        <ListOrdered size={13} />
        待投递 <span>{runtime.queue.length}</span>
      </summary>
      {runtime.queue.map((item: any) => (
        <div className="queue-item" key={item.inputId}>
          <code title={item.inputId}>{item.inputId.slice(0, 8)}</code>
          <span>{item.state}</span>
          <span className="queue-actions">
            {runtime.capabilities?.queueTakeBack && (
              <IconButton
                label="取回，不停止当前回复"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    operation: "take-back",
                    inputId: item.inputId,
                  })
                }
              >
                <Undo2 size={12} />
              </IconButton>
            )}
            {runtime.capabilities?.queueForceSend && (
              <IconButton
                label="立即投递"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    operation: "force-send",
                    inputId: item.inputId,
                  })
                }
              >
                <FastForward size={12} />
              </IconButton>
            )}
          </span>
        </div>
      ))}
      <ErrorBox error={mutation.error} />
    </details>
  );
}

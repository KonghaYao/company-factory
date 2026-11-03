import { RotateCcw } from "lucide-react";
import type { Agent, Runtime } from "../../lib/types";
import { Avatar, IconButton, Spinner } from "../../ui/primitives";

/**
 * 会话头部只回答三件事：跟谁在聊、它现在在做什么、会话是否固定。
 * 其余操作收进右侧图标，避免头部变成工具栏。
 */
export function ChatHeader({
  agent,
  runtime,
  session,
  needsUser,
  onRestart,
  restarting,
}: {
  agent: Agent;
  runtime?: Runtime;
  session?: string;
  needsUser: boolean;
  onRestart: () => void;
  restarting: boolean;
}) {
  const busy = Boolean(
    runtime?.busy ||
      runtime?.running ||
      runtime?.activeTurn?.status === "running",
  );
  return (
    <header className="chat-header">
      <Avatar name={agent.name} color={agent.avatarColor} size="md" />
      <div className="chat-heading-copy">
        <div className="chat-title-line">
          <h1>{agent.name}</h1>
          <span
            className={`presence ${
              busy ? "is-busy" : needsUser ? "is-waiting" : "is-idle"
            }`}
          >
            {busy ? (
              <>
                <Spinner size={11} /> 运行中
              </>
            ) : needsUser ? (
              "等待裁定"
            ) : (
              "空闲"
            )}
          </span>
        </div>
        <p>
          {agent.role}
          <span className="dot-sep">·</span>
          <code className="session-chip" title={session || "等待读取会话绑定"}>
            {session ? session.slice(0, 12) : "SESSION"}
          </code>
        </p>
      </div>
      <div className="chat-header-actions">
        <IconButton
          label="重启 Peri 会话"
          disabled={restarting}
          onClick={onRestart}
        >
          {restarting ? <Spinner size={14} /> : <RotateCcw size={15} />}
        </IconButton>
      </div>
    </header>
  );
}

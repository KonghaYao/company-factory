import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  CornerUpLeft,
  MessageSquare,
  Search,
} from "lucide-react";
import type { Agent, IMMessage, Scope, Thread } from "../../lib/types";
import { action, list } from "../../lib/api";
import { shortDate, statusLabel, statusTone } from "../../lib/format";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorBox,
  Loading,
} from "../../ui/primitives";
import { Markdown } from "../../ui/Markdown";

/** 同事消息：话题列表 + 只读时间线，必要时把上下文带回 Chat。 */
export function MessagesView({
  scope,
  threads,
  agents,
  onDraft,
}: {
  scope: Scope;
  threads: Thread[];
  agents: Agent[];
  onDraft: (text: string) => void;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const thread = threads.find((item) => item.id === selected);
  const query = useInfiniteQuery({
    queryKey: ["thread", scope.companyId, scope.agentId, selected],
    queryFn: ({ pageParam }) =>
      action(scope.companyId, "company_im", "thread", {
        threadId: selected,
        cursor: pageParam,
      }),
    enabled: !!selected,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor || undefined,
    refetchInterval: 3000,
  });
  const items =
    query.data?.pages.flatMap((page) => list<IMMessage>(page, "messages")) || [];
  const nameOf = (id?: string) =>
    agents.find((agent) => (agent.agentId || agent.id) === id)?.name || id || "?";

  if (thread)
    return (
      <div className="panel-scroll">
        <button className="back-link" onClick={() => setSelected(undefined)}>
          <ArrowLeft size={14} />
          我的话题
        </button>
        <header className="section-head section-head-lg">
          <div>
            <span className="panel-kicker">{thread.id}</span>
            <h2>{thread.subject || thread.question || "同事交流"}</h2>
          </div>
          <Badge
            value={statusLabel(thread.status)}
            tone={statusTone(thread.status)}
          />
        </header>
        <div className="notice">
          消息已保存、已送入会话与已回复是不同状态。话题不会自动创建 Issue
          或改变负责人。
        </div>
        {query.isLoading && <Loading />}
        <ErrorBox error={query.error} />
        <div className="im-thread">
          {items.map((message) => (
            <article key={message.id} className="im-message">
              <header>
                <Avatar
                  name={nameOf(message.sender_id || message.author_id)}
                  size="xs"
                />
                <strong>{nameOf(message.sender_id || message.author_id)}</strong>
                <time>{shortDate(message.created_at)}</time>
              </header>
              <Markdown>{message.body}</Markdown>
              <footer>
                <span>{message.id}</span>
                <Badge
                  value={statusLabel(
                    message.delivery_status || message.delivery?.status || "saved",
                  )}
                />
              </footer>
            </article>
          ))}
        </div>
        {query.hasNextPage && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => query.fetchNextPage()}
          >
            加载后续消息
          </button>
        )}
        <button
          className="btn btn-secondary btn-md full-width"
          onClick={() =>
            onDraft(
              `请查看 company_im 话题 ${thread.id} 的最新消息，并按你的职责继续协调。请明确回复原话题，而不是新建 Issue。`,
            )
          }
        >
          <CornerUpLeft size={14} />
          在 Chat 中指导 Agent 跟进
        </button>
      </div>
    );

  const colleagues = agents.filter(
    (agent) =>
      (agent.agentId || agent.id) !== scope.agentId &&
      `${agent.name} ${agent.role} ${agent.responsibilities}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <div className="panel-scroll">
      <header className="section-head section-head-lg">
        <div>
          <h2>同事消息</h2>
          <p>{threads.length} 个话题 · 当前 Agent 参与的点对点交流</p>
        </div>
        <MessageSquare size={18} className="muted" />
      </header>

      {threads.length ? (
        <div className="thread-list">
          {threads.map((item) => (
            <button
              className="thread-card"
              key={item.id}
              onClick={() => setSelected(item.id)}
            >
              <div>
                <span className="panel-kicker">{item.id}</span>
                <Badge
                  value={statusLabel(item.status)}
                  tone={statusTone(item.status)}
                />
              </div>
              <strong>{item.subject || item.question || "同事交流"}</strong>
              <span className="thread-foot">
                {shortDate(item.created_at)}
                <ArrowUpRight size={13} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<MessageSquare size={22} />}
          title="还没有参与的话题"
          description="Agent 可跨部门询问同事。消息先落盘，再投递到对方原有会话。"
        />
      )}

      <section className="panel-section">
        <header className="section-head">
          <h3>公司同事</h3>
          <span className="count-pill">{colleagues.length}</span>
        </header>
        <label className="file-search">
          <Search size={13} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按姓名、岗位或职责查找"
            aria-label="查找同事"
          />
        </label>
        {colleagues.map((agent) => (
          <button
            className="colleague-row"
            key={agent.agentId || agent.id}
            onClick={() =>
              onDraft(
                `请通过 company_im 向同事 ${agent.name}（${agent.agentId || agent.id}，${agent.role}）发起点对点询问：\n`,
              )
            }
          >
            <Avatar name={agent.name} size="sm" />
            <span className="colleague-copy">
              <strong>{agent.name}</strong>
              <small>
                {agent.role} · {agent.responsibilities}
              </small>
            </span>
            <ArrowUpRight size={14} />
          </button>
        ))}
      </section>
    </div>
  );
}

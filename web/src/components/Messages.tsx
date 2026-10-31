import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  MessageSquare,
  ArrowLeft,
  ArrowUpRight,
  Users,
  Search,
  CornerUpLeft,
} from "lucide-react";
import type { Scope, Thread, IMMessage, Agent } from "../lib/types";
import { action, list } from "../lib/api";
import { Empty, Badge, Markdown, shortDate, ErrorBox, Loading } from "./Common";
export function Messages({
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
  const thread = threads.find((t) => t.id === selected);
  const q = useInfiniteQuery({
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
    q.data?.pages.flatMap((p) => list<IMMessage>(p, "messages")) || [];
  if (thread)
    return (
      <div className="panel-content">
        <button className="back-link" onClick={() => setSelected(undefined)}>
          <ArrowLeft size={14} />
          我的话题
        </button>
        <div className="section-heading">
          <div>
            <span className="eyebrow">{thread.id}</span>
            <h2>{thread.subject || thread.question || "同事交流"}</h2>
          </div>
          <Badge value={thread.status} />
        </div>
        <div className="notice subtle">
          消息已保存、已送入会话与已回复是不同状态。话题不会自动创建 Issue
          或改变负责人。
        </div>
        {q.isLoading && <Loading />}
        <ErrorBox error={q.error} />
        {items.map((m) => (
          <article key={m.id} className="im-message">
            <div className="comment-meta">
              <span className="avatar tiny">
                {(
                  agents.find(
                    (a) => (a.agentId || a.id) === (m.sender_id || m.author_id),
                  )?.name ||
                  m.sender_id ||
                  "?"
                ).slice(0, 1)}
              </span>
              <strong>
                {agents.find(
                  (a) => (a.agentId || a.id) === (m.sender_id || m.author_id),
                )?.name ||
                  m.sender_id ||
                  m.author_id}
              </strong>
              <time>{shortDate(m.created_at)}</time>
            </div>
            <Markdown>{m.body}</Markdown>
            <div className="message-receipt">
              <span>{m.id}</span>
              <Badge
                value={m.delivery_status || m.delivery?.status || "saved"}
              />
            </div>
          </article>
        ))}
        {q.hasNextPage && (
          <button className="secondary small" onClick={() => q.fetchNextPage()}>
            加载后续消息
          </button>
        )}
        <button
          className="secondary full-width"
          onClick={() =>
            onDraft(
              `请查看 company_im 话题 ${thread.id} 的最新消息，并按你的职责继续协调。请明确回复原话题，而不是新建 Issue。`,
            )
          }
        >
          <CornerUpLeft size={14} />在 Chat 中指导 Agent 跟进
        </button>
      </div>
    );
  return (
    <div className="panel-content">
      <div className="section-heading">
        <div>
          <h2>消息</h2>
          <p>当前 Agent 参与的点对点话题</p>
        </div>
        <MessageSquare size={18} className="muted" />
      </div>
      {threads.length ? (
        <div className="thread-list">
          {threads.map((t) => (
            <button
              className="thread-card"
              key={t.id}
              onClick={() => setSelected(t.id)}
            >
              <div>
                <span className="eyebrow">{t.id}</span>
                <Badge value={t.status} />
              </div>
              <strong>{t.subject || t.question || "同事交流"}</strong>
              <span>
                {shortDate(t.created_at)}
                <ArrowUpRight size={13} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={<MessageSquare size={27} />} title="还没有参与的话题">
          Agent 可跨部门询问同事。所有消息先落盘，再投递到对方原有会话。
        </Empty>
      )}
      <section className="run-section">
        <div className="subheading">
          <h3>公司同事</h3>
          <Users size={15} />
        </div>
        <div className="file-search">
          <Search size={13} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="按姓名、岗位或职责查找"
            aria-label="查找同事"
          />
        </div>
        {agents
          .filter(
            (a) =>
              (a.agentId || a.id) !== scope.agentId &&
              `${a.name} ${a.role} ${a.responsibilities}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .map((a) => (
            <button
              className="colleague"
              key={a.agentId || a.id}
              onClick={() =>
                onDraft(
                  `请通过 company_im 向同事 ${a.name}（${a.agentId || a.id}，${a.role}）发起点对点询问：\n`,
                )
              }
            >
              <span className="avatar">{a.name.slice(0, 1)}</span>
              <div>
                <strong>{a.name}</strong>
                <p>
                  {a.role} · {a.responsibilities}
                </p>
              </div>
              <ArrowUpRight size={14} />
            </button>
          ))}
      </section>
    </div>
  );
}

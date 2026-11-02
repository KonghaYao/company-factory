import type { Scope } from "../../lib/types";
import {
  ChatController,
  createHttpProjectRepository,
  createHttpRepository,
  createRemoteActions,
} from "../../peri/remote";

/**
 * Company 组合根：Peri 官方 ChatController + 浏览器 WS 同步。
 *
 * 唯一的公司差异是每个请求都带上 scope（companyId + agentId），
 * 服务端据此做鉴权与 Chat 归属校验；不轮询任何聊天快照。
 */
export function createCompanyChatApplication(scope: Scope): ChatController {
  const origin = globalThis.location.origin;
  const query = `?companyId=${encodeURIComponent(scope.companyId)}&agentId=${encodeURIComponent(scope.agentId)}`;
  const scopedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      origin,
    );
    url.searchParams.set("companyId", scope.companyId);
    url.searchParams.set("agentId", scope.agentId);
    return fetch(url, init);
  }) as typeof fetch;
  const repository = createHttpRepository(origin, scopedFetch);
  const projects = createHttpProjectRepository(origin, scopedFetch);
  const socketOrigin = origin.replace(/^http/, "ws");
  return new ChatController({
    actions: createRemoteActions({ origin, fetch: scopedFetch }),
    list: (signal) => repository.list(signal),
    listProjects: (signal) => projects.list(signal),
    createProject: (name) => projects.create(name),
    syncUrl: (address) =>
      `${socketOrigin}/api/chats/${encodeURIComponent(address)}/sync${query}`,
  });
}

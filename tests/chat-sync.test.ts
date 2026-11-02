import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  upgradeWebSocket,
  websocket,
  type BunWebSocketData,
} from "@hono/bun";
import { ChatViewRegistry } from "@peri-code/sdk";
import type { ChatFact, ChatFactObserver, ChatFactSource } from "@peri-code/sdk";
import { ChatReplica } from "@peri-code/sdk/view";
import {
  SYNC_PATH,
  syncEvents,
  syncUpgradeGuard,
  type SyncEnv,
} from "../src/server/peri/sync";

/**
 * 真实 WS 协议回归：Hono(`@hono/bun`) → ChatView → ChatReplica。
 * 不依赖 Agent/WASM/模型；只验证 HELLO → SNAPSHOT → UPDATE → ACK 链路。
 */
class FakeSource implements ChatFactSource {
  readonly id = "chat-test";
  readonly binding = {
    chatId: "chat-test",
    sessionId: "session-test",
    bindingRevision: 1,
  };
  private observer?: ChatFactObserver;
  private sequence = 0;

  subscribeFacts(observer: ChatFactObserver): () => void {
    this.observer = observer;
    queueMicrotask(() => observer.onBinding(this.binding, []));
    return () => {
      if (this.observer === observer) this.observer = undefined;
    };
  }

  emit(fact: ChatFact) {
    this.sequence += 1;
    this.observer?.onFact({
      chatId: this.binding.chatId,
      sessionId: this.binding.sessionId,
      bindingRevision: this.binding.bindingRevision,
      sequence: this.sequence,
      fact,
    });
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${message}`);
}

describe("Peri chat sync over WebSocket", () => {
  const source = new FakeSource();
  const views = new ChatViewRegistry();
  const app = new Hono<SyncEnv>();
  app.all(
    SYNC_PATH,
    syncUpgradeGuard({
      chats: {
        getChat: () => source as any,
        findChatBySession: () => source as any,
      },
      views: { attach: (chat) => views.attach(chat) },
    }),
  );
  app.get(
    SYNC_PATH,
    upgradeWebSocket((c) => syncEvents(c.get("syncConnection")!)),
    (c) => c.text("upgrade rejected", 400),
  );
  const server = Bun.serve<BunWebSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
    websocket,
  });
  const frames = { sent: 0, received: 0 };

  afterAll(() => server.stop(true));

  test("HELLO receives SNAPSHOT, UPDATE reaches the replica, ACK is sent", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/chats/${source.id}/sync`,
    );
    ws.binaryType = "arraybuffer";
    const listeners = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<(error?: Error) => void>();
    const channel = {
      get closed() {
        return ws.readyState === WebSocket.CLOSED;
      },
      send(frame: Uint8Array) {
        frames.sent += 1;
        ws.send(frame.buffer as ArrayBuffer);
      },
      onMessage(listener: (frame: Uint8Array) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener: (error?: Error) => void) {
        closes.add(listener);
        return () => closes.delete(listener);
      },
      close() {
        ws.close();
      },
    };
    ws.addEventListener("message", (event: MessageEvent) => {
      frames.received += 1;
      for (const listener of listeners)
        listener(new Uint8Array(event.data as ArrayBuffer));
    });
    ws.addEventListener("close", () => {
      for (const listener of closes) listener(new Error("closed"));
    });

    const replica = new ChatReplica();
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WS error")), {
        once: true,
      });
    });
    replica.connect(channel);

    await waitFor(() => replica.read().readiness === "ready", "replica ready");
    expect(replica.status).toBe("synced");
    expect(replica.read().sessionId).toBe(source.binding.sessionId);
    expect(frames.sent).toBeGreaterThanOrEqual(1); // HELLO
    expect(frames.received).toBeGreaterThanOrEqual(1); // SNAPSHOT

    source.emit({ kind: "run-state", running: true, executionBlocked: false });
    await waitFor(() => replica.read().running === true, "running update");

    expect(frames.sent).toBeGreaterThanOrEqual(2); // HELLO + ACK
    await replica.dispose();
    ws.close();
  });
});

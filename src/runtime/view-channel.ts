import type { ChatYjsChannel } from "@peri-code/sdk";
interface Endpoint extends ChatYjsChannel {
  messages: Set<(frame: Uint8Array) => void>;
  pair(other: Endpoint): void;
}
/** In-process channel pair feeding the SDK's official read-only ChatReplica. */
export function channelPair(): [ChatYjsChannel, ChatYjsChannel] {
  function endpoint(): Endpoint {
    const messages = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<(error?: Error) => void>();
    let peer: Endpoint;
    let closed = false;
    return {
      get closed() {
        return closed;
      },
      messages,
      pair(other: Endpoint) {
        peer = other;
      },
      send(frame: Uint8Array) {
        const copy = frame.slice();
        queueMicrotask(() => {
          if (!peer.closed)
            for (const listener of peer.messages) listener(copy);
        });
      },
      onMessage(listener: (frame: Uint8Array) => void) {
        messages.add(listener);
        return () => {
          messages.delete(listener);
        };
      },
      onClose(listener: (error?: Error) => void) {
        closes.add(listener);
        return () => {
          closes.delete(listener);
        };
      },
      close(error?: Error) {
        if (closed) return;
        closed = true;
        for (const listener of closes) listener(error);
        if (!peer.closed) void peer.close(error);
      },
    };
  }
  const a = endpoint();
  const b = endpoint();
  a.pair(b);
  b.pair(a);
  return [a, b];
}

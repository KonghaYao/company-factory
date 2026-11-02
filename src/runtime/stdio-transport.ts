import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  Transport,
  JsonRpcNotification,
  ReverseRequestHandler,
} from "@peri-code/sdk";

/** Newline JSON-RPC transport for the official native Peri ACP / Workspace binaries.
 * No agent logic is implemented here. close() resolves only after OS process exit. */
export class StdioTransport implements Transport {
  readonly process: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private listeners = new Set<(event: JsonRpcNotification) => void>();
  private handler?: ReverseRequestHandler;
  private buffer = "";
  private stderr = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private ended = false;
  private exited: Promise<void>;
  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; settings?: unknown },
  ) {
    this.process = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) =>
      this.process.once("close", () => {
        this.ended = true;
        this.receiveOutput(this.stdoutDecoder.end());
        this.stderr = (this.stderr + this.stderrDecoder.end()).slice(-5000);
        this.fail(
          new Error(`Peri process exited. ${this.stderr.slice(-1600)}`),
        );
        resolve();
      }),
    );
    this.process.once("error", (e) => this.fail(e));
    // Consume raw chunks so Bun's pipe stream keeps draining even when one
    // chunk ends inside a character. Each decoder retains those partial bytes.
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-5000);
    });
    this.process.stdout.on("data", (chunk) => {
      this.receiveOutput(this.stdoutDecoder.write(chunk));
    });
    if (options.settings !== undefined) {
      const body = Buffer.from(JSON.stringify(options.settings));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      this.process.stdin.write(Buffer.concat([length, body]));
    }
  }
  private receiveOutput(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        void this.receive(JSON.parse(line));
      } catch (e) {
        this.fail(new Error(`Invalid Peri JSON-RPC frame: ${String(e)}`));
      }
    }
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private async write(frame: unknown) {
    if (this.ended || this.process.stdin.destroyed)
      throw new Error(`Peri transport closed. ${this.stderr.slice(-1600)}`);
    await new Promise<void>((resolve, reject) =>
      this.process.stdin.write(JSON.stringify(frame) + "\n", (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  }
  private async receive(frame: any) {
    if (frame.method && frame.id !== undefined) {
      try {
        if (!this.handler)
          throw new Error(`Unsupported reverse method: ${frame.method}`);
        const result = await this.handler(frame.method, frame.params);
        await this.write({ jsonrpc: "2.0", id: frame.id, result });
      } catch (e) {
        await this.write({
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: -32603,
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    } else if (frame.method) {
      for (const listener of this.listeners) listener(frame);
    } else {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      if (frame.error)
        request.reject(
          Object.assign(new Error(frame.error.message ?? "Peri RPC error"), {
            code: frame.error.code,
            data: frame.error.data,
          }),
        );
      else request.resolve(frame.result);
    }
  }
  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<{ response: Promise<T> }> {
    const id = this.next++;
    const response = new Promise<T>((resolve, reject) =>
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      }),
    );
    // Attach a rejection handler immediately: an OS exit can happen before caller awaits response.
    void response.catch(() => {});
    try {
      await this.write({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (e) {
      this.pending.get(id)?.reject(e as Error);
      this.pending.delete(id);
      throw e;
    }
    return { response };
  }
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return (await this.sendRequest<T>(method, params)).response;
  }
  notify(method: string, params?: unknown) {
    return this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }
  subscribe(listener: (event: JsonRpcNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async *events() {
    const events: JsonRpcNotification[] = [];
    let wake: (() => void) | undefined;
    const off = this.subscribe((event) => {
      events.push(event);
      wake?.();
    });
    try {
      while (!this.ended) {
        if (!events.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
            this.exited.then(resolve);
          });
        while (events.length) yield events.shift()!;
      }
    } finally {
      off();
    }
  }
  setRequestHandler(handler: ReverseRequestHandler) {
    this.handler = handler;
  }
  async close() {
    if (this.ended) return;
    this.process.stdin.end();
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!exited) this.process.kill("SIGTERM");
    const terminated = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!terminated) {
      this.process.kill("SIGKILL");
      await this.exited;
    }
  }
}

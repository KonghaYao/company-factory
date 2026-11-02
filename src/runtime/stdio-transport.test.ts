import { expect, test } from "bun:test";
import { StdioTransport } from "./stdio-transport";

test("stdio preserves Chinese and emoji across OS chunks in results and notifications", async () => {
  const value = "读取中文文件🙂成功";
  const script = `
    let input = "";
    process.stdin.on("data", async chunk => {
      input += chunk;
      if (!input.includes("\\n")) return;
      const request = JSON.parse(input.trim());
      input = "";
      for (const frame of [
        {jsonrpc:"2.0", method:"updated", params:${JSON.stringify(value)}},
        {jsonrpc:"2.0", id:request.id, result:${JSON.stringify(value)}}
      ]) {
        const bytes = Buffer.from(JSON.stringify(frame) + "\\n");
        // Separate every byte of the non-ASCII text with an event-loop delay.
        const start = bytes.indexOf(Buffer.from("读"));
        process.stdout.write(bytes.subarray(0, start));
        for (let i = start; i < bytes.length; i++) {
          process.stdout.write(bytes.subarray(i, i+1));
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      }
    });
  `;
  const transport = new StdioTransport(process.execPath, ["-e", script], { cwd: process.cwd() });
  const notifications: unknown[] = [];
  transport.subscribe((event) => notifications.push(event.params));
  try {
    expect(await transport.request("read")).toBe(value);
    // A long-lived process must deliver before EOF, then remain usable. Some
    // pipe decoders only drain a split character when the child exits.
    expect(transport.process.exitCode).toBeNull();
    expect(await transport.request("read-again")).toBe(value);
    expect(notifications).toEqual([value, value]);
  } finally {
    await transport.close();
  }
});

test("stdio stderr preserves split UTF-8 diagnostics when the process closes", async () => {
  const diagnostic = "读取配置失败🙂";
  const script = `
    process.stdin.once("data", async () => {
      for (const byte of Buffer.from(${JSON.stringify(diagnostic)})) {
        process.stderr.write(Buffer.from([byte]));
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      process.exit(1);
    });
  `;
  const transport = new StdioTransport(process.execPath, ["-e", script], { cwd: process.cwd() });
  try {
    await expect(transport.request("read")).rejects.toThrow(diagnostic);
  } finally {
    await transport.close();
  }
});

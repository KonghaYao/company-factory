/**
 * Minimal ambient declaration for `pino-roll` 4.x.
 *
 * The package is CommonJS and ships no types. Only the in-process
 * `build(options) -> SonicBoom` path used by runtime diagnostics is declared;
 * the worker transport path is intentionally not modelled.
 */
declare module "pino-roll" {
  export interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    symlink?: boolean;
    dateFormat?: string;
    append?: boolean;
    mkdir?: boolean;
    mode?: number;
    minLength?: number;
    maxLength?: number;
    fsync?: boolean;
    sync?: boolean;
  }

  export interface PinoRollStream {
    readonly fd: number;
    readonly file: string;
    write(data: string): boolean;
    flushSync(): void;
    flush(callback?: (error?: Error | null) => void): void;
    end(): void;
    destroy(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  function build(options: PinoRollOptions): Promise<PinoRollStream>;

  export default build;
}

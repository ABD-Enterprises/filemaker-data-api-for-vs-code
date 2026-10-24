/* eslint-disable @typescript-eslint/no-explicit-any */
import net from 'net';

import { helloLine } from '../../../../src/ai/mcp/auth';

/** A small raw client for the server's wire format. */
export class RawClient {
  public readonly lines: string[] = [];
  public closed = false;
  private waiters: Array<() => void> = [];
  private buffer = '';

  private constructor(public readonly socket: net.Socket) {
    socket.on('data', (data) => {
      this.buffer += data.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        this.lines.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
      }
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', () => undefined);
  }

  public static connect(path: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      socket.once('connect', () => resolve(new RawClient(socket)));
      socket.once('error', reject);
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  public write(text: string): void {
    this.socket.write(text);
  }

  public send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  public async hello(token: string): Promise<string> {
    this.write(helloLine(token));
    return this.next();
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.push(wake);
    });
  }

  /** The next line, or '<closed>' if the connection closes first. */
  public async next(timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.closed) return '<closed>';
      if (Date.now() >= deadline) return '<timeout>';
      await this.waitForChange(deadline - Date.now());
    }
    return this.lines.shift() as string;
  }

  public async json(timeoutMs = 2000): Promise<any> {
    return JSON.parse(await this.next(timeoutMs));
  }

  public async waitClosed(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await this.waitForChange(deadline - Date.now());
    }
    return this.closed;
  }

  public close(): void {
    this.socket.destroy();
  }
}

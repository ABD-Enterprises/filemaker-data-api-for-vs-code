import * as vscode from 'vscode';

import { redactString } from '../utils/redact';
import { SettingsService } from './settingsService';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly settingsService: SettingsService;

  public constructor(private readonly extensionName: string, settingsService?: SettingsService) {
    this.channel = vscode.window.createOutputChannel(this.extensionName);
    this.settingsService = settingsService ?? new SettingsService();
  }

  public show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  public debug(message: string, meta?: unknown): void {
    this.log('debug', message, meta);
  }

  public info(message: string, meta?: unknown): void {
    this.log('info', message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.log('warn', message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.log('error', message, meta);
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    const configuredLevel = this.getConfiguredLogLevel();
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[configuredLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level.toUpperCase()}] ${redactString(message)}`;

    if (meta === undefined) {
      this.channel.appendLine(base);
      return;
    }

    this.channel.appendLine(`${base} ${redactString(this.serializeMeta(meta))}`);
  }

  private getConfiguredLogLevel(): LogLevel {
    const value = this.settingsService.getLoggingLevel();

    if (value in LOG_LEVEL_ORDER) {
      return value;
    }

    return 'info';
  }

  private serializeMeta(meta: unknown): string {
    if (typeof meta === 'string') {
      return meta;
    }

    try {
      return JSON.stringify(meta);
    } catch {
      return String(meta);
    }
  }

  // Redaction is centralized in utils/redact.ts.
}

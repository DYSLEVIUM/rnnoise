export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  SILENT = 5,
}

export interface LogContext {
  processor?: string;
  component?: string;
  trackId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

type LogMethod = (message: string, context?: LogContext, ...args: unknown[]) => void;

export interface IRNNoiseLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  createChild(context: LogContext): IRNNoiseLogger;
}

export class RNNoiseLogger implements IRNNoiseLogger {
  private level: LogLevel;
  private readonly context: LogContext;
  private readonly prefix = '[RNNoise]';

  constructor(level: LogLevel = LogLevel.INFO, context: LogContext = {}) {
    this.level = level;
    this.context = context;
  }

  private formatMessage(level: string, message: string, context?: LogContext): string {
    const mergedContext = { ...this.context, ...context };
    const contextStr =
      Object.keys(mergedContext).length > 0 ? ` ${JSON.stringify(mergedContext)}` : '';
    return `${this.prefix}[${level}]${contextStr} ${message}`;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  trace(message: string, context?: LogContext, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.TRACE)) {
      console.log(this.formatMessage('TRACE', message, context), ...args);
    }
  }

  debug(message: string, context?: LogContext, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage('DEBUG', message, context), ...args);
    }
  }

  info(message: string, context?: LogContext, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage('INFO', message, context), ...args);
    }
  }

  warn(message: string, context?: LogContext, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('WARN', message, context), ...args);
    }
  }

  error(message: string, context?: LogContext, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage('ERROR', message, context), ...args);
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  createChild(context: LogContext): IRNNoiseLogger {
    return new RNNoiseLogger(this.level, { ...this.context, ...context });
  }
}

let globalLogger: IRNNoiseLogger = new RNNoiseLogger();

export function getRNNoiseLogger(): IRNNoiseLogger {
  return globalLogger;
}

export function setRNNoiseLogger(logger: IRNNoiseLogger): void {
  globalLogger = logger;
}

export function setRNNoiseLogLevel(level: LogLevel): void {
  globalLogger.setLevel(level);
}

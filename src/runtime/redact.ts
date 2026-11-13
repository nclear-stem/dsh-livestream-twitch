/**
 * Log redaction. Every log line and every error message that leaves this plugin goes through `redact`.
 * Two layers: pattern rules for things that look like credentials, and exact values registered at runtime
 * (the live access/refresh token, client secret, OAuth code) so they are masked even in odd positions.
 */

const known = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value);
}

export function forgetSecret(value: string | undefined | null): void {
  if (value) known.delete(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]'],
  [/\b(access_token|refresh_token|client_secret|code|token|state)=([^&\s"']+)/gi, '$1=[REDACTED]'],
  [/"(access_token|refresh_token|client_secret|accessToken|refreshToken|clientSecret|code)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"'],
  [/\b(authorization)\s*[:=]\s*[^\s,;]+(\s+[^\s,;]+)?/gi, '$1: [REDACTED]'],
];

export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input);
  for (const secret of known) if (text.includes(secret)) text = text.split(secret).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) text = text.replace(re, rep);
  return text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LogSink = (level: LogLevel, message: string) => void;

/** Logger whose every line is redacted before it reaches the sink. */
export function createLogger(sink: LogSink, prefix = 'dsh-livestream-twitch'): Logger {
  const emit = (level: LogLevel) => (message: string) => sink(level, `${prefix}: ${redact(message)}`);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const consoleSink: LogSink = (level, message) => {
  if (level === 'debug') return;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(message);
};

/** Error safe to surface: message redacted, no cause chain carrying request bodies. */
export function safeError(err: unknown): Error {
  return new Error(redact(err instanceof Error ? err.message : err));
}

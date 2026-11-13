/**
 * Minimal compatibility layer over the DSH (Cordis) services this plugin uses. Verified against
 * @deepseek-ai/dsh 0.2.1-rc.3 type definitions:
 *
 *   ctx.credentials  CredentialProvider: resolve(ref), readRecord/modifyRecord/deleteRecord(key)
 *                    (`modifyRecord` is a serialized, cross-process-locked read-modify-write)
 *   ctx.agents       AgentRegistry: get(sessionId) -> Agent { session, followup(UserMessage) }
 *   sessionController resolveAgent(sessionId) -> { agent } | { error }   (resumes cold sessions)
 *   ctx.commands     CommandRuntime.register({ name, description, input, handler }) -> disposer
 *   ctx.connection   fetch.register({ path, methods, requestBody, fetch }) -> disposer
 *   ctx.tools        tool registry (agent-scoped, used by the agent sub-plugin)
 *
 * Only the members listed here are touched; everything is reached through `ctx.get` so a profile that lacks
 * an optional service (commands in headless, credentials in a bare SDK) still loads the plugin.
 */

export interface CordisLikeContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): unknown;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void; debug?(m: string): void };
  [service: string]: unknown;
}

export interface DshCredentialRecord {
  readonly kind: string;
  readonly payload?: unknown;
}

export interface DshCredentials {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  readRecord(key: string): Promise<DshCredentialRecord | undefined>;
  modifyRecord(key: string, mutate: (current: DshCredentialRecord | undefined) => Promise<DshCredentialRecord | undefined>): Promise<DshCredentialRecord | undefined>;
  deleteRecord(key: string): Promise<void>;
}

export interface DshUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly source: { kind: string };
}

export interface DshSessionEvent {
  type: string;
  seq: number;
  data?: unknown;
}

export interface DshSession {
  readonly seq: number;
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly DshSessionEvent[];
}

export interface DshAgent {
  readonly id: string;
  readonly session: DshSession;
  followup(message: DshUserMessage): void;
}

export interface DshAgents {
  get(id: string): DshAgent | undefined;
}

export interface DshSessionController {
  resolveAgent(sessionId: string): Promise<{ agent: DshAgent } | { error: { message?: string } | unknown }>;
}

export interface DshCommandInvocation {
  readonly agent: { readonly id: string };
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

export type DshCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

export interface DshCommands {
  register(def: {
    name: string;
    description: string;
    input?: { hint: string };
    handler: (inv: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>;
  }): () => void;
}

export interface DshConnection {
  fetch: {
    register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch: (request: Request) => Response | Promise<Response> }): () => void;
  };
}

function service<T>(ctx: CordisLikeContext, name: string): T | undefined {
  try {
    return (ctx.get?.(name) ?? undefined) as T | undefined;
  } catch {
    return undefined;
  }
}

export const host = {
  credentials: (ctx: CordisLikeContext) => service<DshCredentials>(ctx, 'credentials'),
  agents: (ctx: CordisLikeContext) => service<DshAgents>(ctx, 'agents'),
  sessionController: (ctx: CordisLikeContext) => service<DshSessionController>(ctx, 'sessionController'),
  commands: (ctx: CordisLikeContext) => service<DshCommands>(ctx, 'commands'),
  /** Injected service: read as a property like the Bilibili plugin does. */
  connection: (ctx: CordisLikeContext) => ctx.connection as DshConnection | undefined,
};

/**
 * Delivering one message to a DSH agent session and reading its reply, using only verified DSH APIs:
 *
 *   ctx.agents.get(id) / sessionController.resolveAgent(id)   live Agent (resumes a cold session)
 *   agent.followup(UserMessage)                                queues the message as its own turn and wakes it
 *   agent.session.seq / snapshotEvents(fromSeq)                durable event log of the session
 *
 * Correlation: our `user/message` event carries the message id we minted. The reply is the text of the
 * `assistant/message` events after it, up to the `turn/end` that closes that turn.
 */

import { randomUUID } from 'node:crypto';
import type { DshAgent, DshAgents, DshSessionController, DshSessionEvent, DshUserMessage } from '../dsh/host';
import { sleep, type Timers } from '../runtime/timers';

export interface AgentReply {
  text: string;
  turnCompleted: boolean;
}

export interface AgentPort {
  available(): boolean;
  deliver(sessionId: string, text: string, signal: AbortSignal): Promise<AgentReply>;
}

export class AgentUnavailableError extends Error {}

export const MESSAGE_SOURCE_KIND = 'dsh-livestream-twitch';

/** Text parts of one assistant/message event. */
export function assistantText(event: DshSessionEvent): string {
  const content = (event.data as { message?: { content?: Array<{ type?: string; text?: unknown }> } } | undefined)?.message?.content ?? [];
  return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => (p.text as string).trim()).filter(Boolean).join('\n');
}

/** Scan new session events for the turn answering `messageId`. Stateful across calls. */
export class ReplyCollector {
  private collecting = false;
  private readonly parts: string[] = [];
  done = false;
  constructor(private readonly messageId: string) {}

  feed(events: readonly DshSessionEvent[]): void {
    for (const e of events) {
      if (this.done) return;
      if (e.type === 'user/message' && (e.data as { id?: unknown } | undefined)?.id === this.messageId) this.collecting = true;
      else if (this.collecting && e.type === 'assistant/message') {
        const t = assistantText(e);
        if (t) this.parts.push(t);
      } else if (this.collecting && e.type === 'turn/end') this.done = true;
    }
  }

  get text(): string {
    return this.parts.join('\n').trim();
  }
}

export interface DshAgentPortDeps {
  agents: () => DshAgents | undefined;
  sessionController: () => DshSessionController | undefined;
  timers: Timers;
  pollMs?: number;
}

export class DshAgentPort implements AgentPort {
  constructor(private readonly deps: DshAgentPortDeps) {}

  available(): boolean {
    return !!this.deps.agents() || !!this.deps.sessionController();
  }

  private async resolve(sessionId: string): Promise<DshAgent> {
    const live = this.deps.agents()?.get(sessionId);
    if (live) return live;
    const controller = this.deps.sessionController();
    if (controller) {
      const r = await controller.resolveAgent(sessionId);
      if ('agent' in r && typeof r.agent?.followup === 'function') return r.agent;
      const err = (r as { error?: { message?: string } }).error;
      throw new AgentUnavailableError(`cannot open DSH session ${sessionId}: ${err?.message ?? 'unknown error'}`);
    }
    throw new AgentUnavailableError(`DSH session ${sessionId} is not live and this profile has no session controller`);
  }

  async deliver(sessionId: string, text: string, signal: AbortSignal): Promise<AgentReply> {
    const agent = await this.resolve(sessionId);
    const id = randomUUID();
    const collector = new ReplyCollector(id);
    let cursor = Number(agent.session.seq);
    const message: DshUserMessage = Object.freeze({ id, role: 'user', content: Object.freeze([Object.freeze({ type: 'text' as const, text })]), source: Object.freeze({ kind: MESSAGE_SOURCE_KIND }) });
    agent.followup(message);
    while (!collector.done) {
      await sleep(this.deps.timers, this.deps.pollMs ?? 250, signal);
      const events = agent.session.snapshotEvents(cursor);
      cursor = Number(agent.session.seq);
      collector.feed(events);
    }
    return { text: collector.text, turnCompleted: true };
  }
}

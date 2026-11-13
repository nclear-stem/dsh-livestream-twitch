import { formatStatus } from '../runtime/status';
import type { Supervisor } from '../runtime/supervisor';

export function statusCommand(sup: Supervisor): string {
  const s = sup.runtime.status.snapshot();
  const last = sup.lastAuthorization;
  const tail = last && !last.ok ? `\nLast authorization attempt failed: ${last.error}` : '';
  return formatStatus(s) + tail;
}

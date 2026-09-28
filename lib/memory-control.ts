// Server-only, runtime-read switch. This is a restart boundary, not cancellation of
// work already in flight: stop/drain the old process before activating it.
export function memoryDisabled(): boolean {
  return process.env.MOT_MEMORY_DISABLE === '1';
}

export class MemoryDisabledError extends Error {
  constructor() {
    super('M.O.T. memory is disabled');
    this.name = 'MemoryDisabledError';
  }
}

export function requireMemoryEnabled(): void {
  if (memoryDisabled()) throw new MemoryDisabledError();
}

export function memoryUnavailable(): Response {
  return Response.json({ error: 'memory_disabled' }, { status: 503 });
}

// Positive allowlist: new tools stay unavailable in ticket-only mode until
// explicitly classified here. Cached memory tool names must also be refused.
const TICKET_ONLY_TOOLS = new Set([
  'mot_list_tickets', 'mot_get_ticket', 'mot_create_ticket', 'mot_update_ticket',
  'mot_get_status', 'mot_get_ministry_config', 'notify_robin', 'deploy_drift_check',
]);

export function toolAvailable(name: string): boolean {
  return !memoryDisabled() || TICKET_ONLY_TOOLS.has(name);
}

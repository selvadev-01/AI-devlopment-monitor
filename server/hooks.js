// The monitor's entries in a Claude Code settings file (~/.claude/settings.json): pure functions
// shared by scripts/install-hooks.js (CLI) and the VS Code extension's "Install Claude Code Hooks".

export const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
export const PLAIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification'];
export const ALL_EVENTS = [...TOOL_EVENTS, ...PLAIN_EVENTS];

const SENDER_MARKER = 'send-event.js';
const ENSURE_MARKER = 'ensure-server.js';
const isEventUrl = (u) => /^http:\/\/127\.0\.0\.1:\d+\/event$/.test(String(u || ''));
const isAutostart = (h) => String(h.command || '').includes(ENSURE_MARKER);
const isSender = (h) => String(h.command || '').includes(SENDER_MARKER) || isEventUrl(h.url);

/** A hook group that belongs to the monitor (event sender or auto-start, any port). */
export const isOurs = (group) => (group.hooks || []).some((h) => isSender(h) || isAutostart(h));

/**
 * Settings with the monitor's hooks added (or removed). The input is not changed.
 * @param opts.port       monitor port (http hooks go to 127.0.0.1:<port>/event)
 * @param opts.command    use this command hook instead of http (old style), e.g. node ".../send-event.js"
 * @param opts.autostart  SessionStart command that starts the monitor; 'keep' leaves an existing one
 *                        as it is (the extension starts the server itself), null/undefined adds none
 * @param opts.uninstall  remove every monitor hook instead
 */
export function applyHooks(settings, { port = 7777, command = null, autostart = null, uninstall = false } = {}) {
  const out = structuredClone(settings || {});
  out.hooks ??= {};
  const hook = command ? { type: 'command', command, async: true } : { type: 'http', url: `http://127.0.0.1:${port}/event`, timeout: 3 };
  for (const evt of ALL_EVENTS) {
    const before = out.hooks[evt] || [];
    const kept = before.filter((g) => !isOurs(g));
    if (!uninstall) {
      const group = { hooks: [{ ...hook }] };
      if (TOOL_EVENTS.includes(evt)) group.matcher = '*';
      kept.push(group);
      if (evt === 'SessionStart') {
        if (autostart === 'keep') kept.push(...before.filter((g) => isOurs(g) && (g.hooks || []).some(isAutostart)));
        else if (autostart) kept.push({ hooks: [{ type: 'command', command: autostart, async: true, timeout: 15 }] });
      }
    }
    if (kept.length) out.hooks[evt] = kept; else delete out.hooks[evt];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

/** Whether every event has a monitor hook, and to which ports they send. */
export function hooksStatus(settings, port = 7777) {
  const ports = new Set(); const missing = [];
  for (const evt of ALL_EVENTS) {
    const hs = (settings?.hooks?.[evt] || []).flatMap((g) => g.hooks || []).filter(isSender);
    if (!hs.length) missing.push(evt);
    for (const h of hs) { const m = /:(\d+)\/event$/.exec(String(h.url || '')); if (m) ports.add(Number(m[1])); }
  }
  const wrongPort = [...ports].some((p) => p !== port);
  return { installed: missing.length === 0 && !wrongPort, partial: missing.length > 0 && missing.length < ALL_EVENTS.length, missing, ports: [...ports], wrongPort };
}

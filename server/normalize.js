// Turns raw Claude Code hook payloads into small visual events.
import fs from 'node:fs';
import path from 'node:path';

const lines = (s) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Prompts can carry harness-injected blocks like <system-reminder>…</system-reminder>; show only the user's text.
const stripInjected = (s) => String(s ?? '').replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

const TEST_CMD = /\b(jest|vitest|pytest|mocha|playwright test|cypress run|go test|cargo test|dotnet test|phpunit|rspec|npm (run )?test|npm t\b|pnpm (run )?test|yarn test|bun test)\b/i;

function responseText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  const parts = [];
  for (const k of ['stdout', 'stderr', 'output', 'content', 'result']) {
    if (typeof resp[k] === 'string') parts.push(resp[k]);
  }
  return parts.length ? parts.join('\n') : JSON.stringify(resp);
}

export function parseTestOutput(text) {
  const num = (re) => {
    let total = 0; let hit = false;
    for (const m of text.matchAll(re)) { total = Math.max(total, Number(m[1])); hit = true; }
    return hit ? total : null;
  };
  const passed = num(/(\d+)\s+(?:passed|passing|tests? passed)\b/gi);
  const failed = num(/(\d+)\s+(?:failed|failing|tests? failed)\b/gi) ?? 0;
  const failingFiles = new Set();
  for (const m of text.matchAll(/^\s*(?:FAIL|✗|×)\s+(\S+\.\w+)/gm)) failingFiles.add(m[1]);
  for (const m of text.matchAll(/^FAILED\s+([^\s:]+)/gm)) failingFiles.add(m[1]);
  const looksFailed = failed > 0 || failingFiles.size > 0 || /\bFAIL\b|Tests? failed/i.test(text);
  return {
    passed: passed ?? 0,
    failed: failed || (looksFailed ? Math.max(1, failingFiles.size) : 0),
    failingFiles: [...failingFiles].slice(0, 20),
  };
}

/** @returns {object|null} event { kind, tool, file (abs or null), detail, stats, session, cwd } */
export function normalizeHook(p) {
  const hook = p.hook_event_name;
  const tool = p.tool_name;
  const input = p.tool_input || {};
  const base = { session: p.session_id || 'unknown', cwd: p.cwd || null, tool: tool || null, agent: p.agent_id || null };

  switch (hook) {
    case 'SessionStart':
      return { ...base, kind: 'session', detail: `Session started (${p.source || 'startup'})` };
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt', detail: short(stripInjected(p.prompt), 140) || 'New prompt' };
    case 'Stop':
      return { ...base, kind: 'idle', detail: 'Waiting for you' };
    case 'SubagentStop':
      return { ...base, kind: 'agent_stop', detail: 'Subagent finished' };
    case 'Notification':
      return { ...base, kind: 'notify', detail: short(p.message, 120) };
    case 'PreToolUse':
      return preTool(base, tool, input);
    case 'PostToolUse':
      return postTool(base, tool, input, p.tool_response);
    default:
      return null;
  }
}

function preTool(base, tool, input) {
  const file = input.file_path || input.notebook_path || null;
  const name = path.basename(file || '');
  switch (tool) {
    case 'Read':
      return { ...base, kind: 'read', file, detail: `Read ${name}` };
    case 'Edit':
      return { ...base, kind: 'edit', file, stats: { added: lines(input.new_string), removed: lines(input.old_string) }, detail: `Edit ${name}` };
    case 'MultiEdit': {
      const stats = { added: 0, removed: 0 };
      for (const e of input.edits || []) { stats.added += lines(e.new_string); stats.removed += lines(e.old_string); }
      return { ...base, kind: 'edit', file, stats, detail: `Edit ${name}` };
    }
    case 'NotebookEdit':
      return { ...base, kind: 'edit', file, stats: { added: lines(input.new_source), removed: 0 }, detail: `Edit ${name}` };
    case 'Write': {
      let existed = false; let oldLines = 0;
      try {
        if (file && fs.existsSync(file)) { existed = true; oldLines = lines(fs.readFileSync(file, 'utf8')); }
      } catch { /* treat as new */ }
      return {
        ...base,
        kind: existed ? 'edit' : 'create',
        file,
        stats: { added: lines(input.content), removed: oldLines },
        detail: `${existed ? 'Rewrite' : 'Create'} ${name}`,
      };
    }
    case 'Grep':
    case 'Glob':
      return { ...base, kind: 'search', file: input.path || null, detail: `${tool} ${short(input.pattern, 60)}` };
    case 'Bash':
    case 'PowerShell': {
      const cmd = input.command || '';
      return { ...base, kind: 'bash', isTest: TEST_CMD.test(cmd), detail: `$ ${short(cmd, 100)}` };
    }
    case 'Task':
    case 'Agent':
      return {
        ...base,
        kind: 'agent_start',
        detail: short(input.description || input.subagent_type || 'Subagent', 80),
        agentType: input.subagent_type || 'general',
      };
    case 'WebFetch':
    case 'WebSearch':
      return { ...base, kind: 'web', detail: `${tool} ${short(input.url || input.query, 70)}` };
    default:
      return { ...base, kind: 'other', detail: short(tool, 60) };
  }
}

function postTool(base, tool, input, resp) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null; // other tools are fully described by PreToolUse
  const cmd = input.command || '';
  const text = responseText(resp);
  const interrupted = Boolean(resp && typeof resp === 'object' && resp.interrupted);
  if (TEST_CMD.test(cmd)) {
    const r = parseTestOutput(text);
    return {
      ...base,
      kind: 'test_result',
      ok: !interrupted && r.failed === 0,
      stats: { passed: r.passed, failed: r.failed },
      failingFiles: r.failingFiles,
      detail: r.failed ? `${r.failed} failed · ${r.passed} passed` : `${r.passed || 'All'} passed`,
    };
  }
  const stderr = resp && typeof resp === 'object' ? String(resp.stderr || '') : '';
  const errored = interrupted || /\b(error|exception|not recognized|command not found)\b/i.test(stderr);
  return { ...base, kind: 'bash_result', ok: !errored, detail: `${errored ? 'Failed' : 'Done'}: ${short(cmd, 70)}` };
}

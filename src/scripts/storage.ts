// ─── Types ────────────────────────────────────────────────────────────────────

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface ModelResponse {
  model: string;
  content: string;
  finishReason?: string | null;
  usage?: Usage | null;
  error?: string | null;
}

export interface LogEntry {
  ts: number;
  durationMs: number;
  kind: 'model' | 'synthesis' | 'retry' | 'judge';
  model: string;
  genId: string | null;
  provider: string | null;
  status: 'ok' | 'error' | 'truncated';
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  error?: string;
}

export interface FusionMeta {
  finishReason?: string | null;
  usage?: Usage | null;
  error?: string | null;
  skipped?: 'all-failed' | 'single' | 'partial-failure' | null;
}

export interface Turn {
  userMessage: string;
  modelResponses: ModelResponse[];
  fusedResponse: string;
  judgeAnalysis?: string;   // judge's comparison — markdown, or raw judge text when JSON parse failed
  fusion?: FusionMeta;
  calls?: LogEntry[];
}

export interface FusionRun {
  id: string;
  title: string;
  createdAt: number;
  models: string[];
  systemPrompt: string;
  turns: Turn[];
}

export interface Settings {
  apiKey: string;
  fusionModel: string;
  theme: 'dark' | 'light';
  temperature: string;                          // raw input value; '' = provider default (param omitted)
  effort: 'off' | 'low' | 'medium' | 'high';    // 'off' = reasoning param omitted
}

const SETTINGS_DEFAULTS: Settings = { apiKey: '', fusionModel: 'auto', theme: 'dark', temperature: '', effort: 'off' };

// ─── Keys ─────────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'or_fusion_settings';
const RUNS_KEY = 'or_fusion_runs';

// ─── Settings ─────────────────────────────────────────────────────────────────

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...SETTINGS_DEFAULTS };
}

export function saveSettings(s: Partial<Settings>): void {
  const current = getSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...s }));
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export function getRuns(): FusionRun[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (raw) return JSON.parse(raw) as FusionRun[];
  } catch {}
  return [];
}

export function saveRun(run: FusionRun): void {
  const runs = getRuns().filter((r) => r.id !== run.id);
  runs.unshift(run);
  // keep last 50 runs
  localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, 50)));
}

export function deleteRun(id: string): void {
  const runs = getRuns().filter((r) => r.id !== id);
  localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
}

export function createRun(models: string[], systemPrompt: string): FusionRun {
  return {
    id: crypto.randomUUID(),
    title: 'New Fusion',
    createdAt: Date.now(),
    models,
    systemPrompt,
    turns: [],
  };
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function formatUsage(u: Usage | null | undefined): string {
  if (!u) return '';
  return `${u.promptTokens.toLocaleString('en-US')}→${u.completionTokens.toLocaleString('en-US')} tok · $${u.cost.toFixed(4)}`;
}

// ─── Export / disk formats ────────────────────────────────────────────────────

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'untitled';
}

export function runFilename(run: FusionRun): string {
  const d = new Date(run.createdAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date}-${run.id.slice(0, 8)}-${slugify(run.title)}.md`;
}

export function runToMarkdown(run: FusionRun): string {
  const lines: string[] = [];
  lines.push(`# ${run.title}`, '');
  lines.push(`- **Created:** ${new Date(run.createdAt).toISOString()}`);
  lines.push(`- **Models:** ${run.models.join(', ')}`);
  if (run.systemPrompt) lines.push(`- **System prompt:** ${run.systemPrompt}`);
  lines.push('');
  run.turns.forEach((turn, i) => {
    lines.push(`## Turn ${i + 1}`, '', '### User', '', turn.userMessage, '');
    for (const r of turn.modelResponses) {
      const status = r.error ? `error: ${r.error}` : r.finishReason === 'length' ? 'truncated' : 'ok';
      const usage = formatUsage(r.usage);
      lines.push(`### ${r.model} (${status}${usage ? ` · ${usage}` : ''})`, '', r.content || '_(no content)_', '');
    }
    if (turn.judgeAnalysis) {
      lines.push('### Judge analysis', '', turn.judgeAnalysis, '');
    }
    lines.push(`### Fused answer${turn.fusion?.skipped ? ` (synthesis skipped: ${turn.fusion.skipped})` : ''}`, '');
    lines.push(turn.fusedResponse || '_(none)_', '');
    if (turn.calls?.length) {
      lines.push('#### Call log', '');
      lines.push('| time | kind | model | genId | status | tokens | cost |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const c of turn.calls) {
        const tokens = c.promptTokens != null ? `${c.promptTokens}→${c.completionTokens}` : '';
        const cost = c.cost != null ? `$${c.cost.toFixed(4)}` : '';
        lines.push(`| ${new Date(c.ts).toISOString()} | ${c.kind} | ${c.model} | ${c.genId ?? ''} | ${c.status} | ${tokens} | ${cost} |`);
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}

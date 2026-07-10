// ─── Types ────────────────────────────────────────────────────────────────────

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface ModelResponse {
  model: string;
  content: string;
}

export interface Turn {
  userMessage: string;
  modelResponses: ModelResponse[];
  fusedResponse: string;
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
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'or_fusion_settings';
const RUNS_KEY = 'or_fusion_runs';

// ─── Settings ─────────────────────────────────────────────────────────────────

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as Settings;
  } catch {}
  return { apiKey: '', fusionModel: 'auto', theme: 'dark' };
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

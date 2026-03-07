import fs from 'fs';
import path from 'path';
import os from 'os';

const SAVINGS_FILE = path.join(
  process.env['CODE_INDEX_PATH'] ?? path.join(os.homedir(), '.code-index'),
  '_savings.json',
);

interface SavingsData {
  total_tokens_saved: number;
}

const BYTES_PER_TOKEN = 4;
const CLAUDE_OPUS_COST_PER_M = 15.0;
const GPT_COST_PER_M = 10.0;

function loadSavings(): SavingsData {
  try {
    const raw = fs.readFileSync(SAVINGS_FILE, 'utf8');
    return JSON.parse(raw) as SavingsData;
  } catch {
    return { total_tokens_saved: 0 };
  }
}

function writeSavings(data: SavingsData): void {
  try {
    fs.mkdirSync(path.dirname(SAVINGS_FILE), { recursive: true });
    const tmp = SAVINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, SAVINGS_FILE);
  } catch {
    // Non-fatal
  }
}


export function estimateSavings(rawBytes: number, responseBytes: number): number {
  const saved = Math.max(0, rawBytes - responseBytes);
  return Math.floor(saved / BYTES_PER_TOKEN);
}

export function recordSavings(delta: number): number {
  if (delta <= 0) return getTotalSaved();
  const data = loadSavings();
  data.total_tokens_saved += delta;
  writeSavings(data);
  return data.total_tokens_saved;
}

export function getTotalSaved(): number {
  return loadSavings().total_tokens_saved;
}

export function costAvoided(tokensSaved: number, totalSaved: number): Record<string, number> {
  return {
    cost_avoided_claude_usd: parseFloat(((tokensSaved / 1_000_000) * CLAUDE_OPUS_COST_PER_M).toFixed(6)),
    cost_avoided_gpt_usd: parseFloat(((tokensSaved / 1_000_000) * GPT_COST_PER_M).toFixed(6)),
    total_cost_avoided_claude_usd: parseFloat(((totalSaved / 1_000_000) * CLAUDE_OPUS_COST_PER_M).toFixed(6)),
  };
}

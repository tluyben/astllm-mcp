import https from 'https';
import http from 'http';
import { CodeSymbol } from '../parser/symbols.js';

// ─── Tier 1: free docstring extraction ───────────────────────────────────────

function extractDocstringLine(sym: CodeSymbol): string | null {
  if (!sym.docstring) return null;
  const first = sym.docstring.split('\n')[0].trim().replace(/^[/*#\s]+/, '');
  const dot = first.indexOf('.');
  const summary = dot > 0 ? first.slice(0, dot + 1) : first;
  return summary.length > 10 ? summary.slice(0, 120) : null;
}

// ─── Tier 3: fallback from signature ─────────────────────────────────────────

function signatureFallback(sym: CodeSymbol): string {
  const kind = sym.kind;
  const name = sym.name;
  const sig = sym.signature;
  return `${kind.charAt(0).toUpperCase() + kind.slice(1)} '${name}': ${sig.slice(0, 80)}`;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : undefined,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(symbols: CodeSymbol[]): string {
  const items = symbols.map((s, i) =>
    `${i + 1}. [${s.kind}] ${s.qualified_name}\n   Signature: ${s.signature}\n   ${s.docstring ? `Docstring: ${s.docstring.slice(0, 200)}` : ''}`
  ).join('\n\n');
  return `For each numbered code symbol below, write ONE short sentence (max 15 words) describing what it does. Focus on behavior, not implementation. Reply with ONLY numbered lines matching the input order.\n\n${items}`;
}

function parseNumberedResponse(text: string, count: number): string[] {
  const lines = text.split('\n').filter(l => /^\d+\./.test(l.trim()));
  return Array.from({ length: count }, (_, i) => {
    const line = lines[i];
    if (!line) return '';
    return line.replace(/^\d+\.\s*/, '').trim();
  });
}

// ─── Anthropic Haiku ──────────────────────────────────────────────────────────

async function anthropicBatch(symbols: CodeSymbol[], apiKey: string): Promise<string[]> {
  const prompt = buildPrompt(symbols);
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = await httpPost('https://api.anthropic.com/v1/messages', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }, body);
  const parsed = JSON.parse(raw) as { content: Array<{ text: string }> };
  const text = parsed.content?.[0]?.text ?? '';
  return parseNumberedResponse(text, symbols.length);
}

// ─── Gemini Flash ────────────────────────────────────────────────────────────

async function geminiBatch(symbols: CodeSymbol[], apiKey: string): Promise<string[]> {
  const prompt = buildPrompt(symbols);
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const raw = await httpPost(url, { 'Content-Type': 'application/json' }, body);
  const parsed = JSON.parse(raw) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return parseNumberedResponse(text, symbols.length);
}

// ─── OpenAI-compatible (local LLMs via Ollama etc.) ──────────────────────────

async function openaiCompatBatch(symbols: CodeSymbol[], baseUrl: string, model: string, apiKey?: string): Promise<string[]> {
  const prompt = buildPrompt(symbols);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const raw = await httpPost(`${baseUrl}/chat/completions`, headers, body);
  const parsed = JSON.parse(raw) as { choices: Array<{ message: { content: string } }> };
  const text = parsed.choices?.[0]?.message?.content ?? '';
  return parseNumberedResponse(text, symbols.length);
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function summarizeSymbols(
  symbols: CodeSymbol[],
  batchSize = 20,
): Promise<void> {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const googleKey = process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
  const openaiBase = process.env['OPENAI_BASE_URL'] ?? process.env['OPENAI_API_BASE'];
  const openaiModel = process.env['OPENAI_MODEL'] ?? 'llama3';
  const openaiKey = process.env['OPENAI_API_KEY'];

  // First pass: free docstring extraction
  for (const sym of symbols) {
    if (!sym.summary) {
      const ds = extractDocstringLine(sym);
      if (ds) sym.summary = ds;
    }
  }

  const needSummary = symbols.filter(s => !s.summary);
  if (needSummary.length === 0) return;

  // Second pass: AI summaries in batches
  for (let i = 0; i < needSummary.length; i += batchSize) {
    const batch = needSummary.slice(i, i + batchSize);
    try {
      let summaries: string[];
      if (anthropicKey) {
        summaries = await anthropicBatch(batch, anthropicKey);
      } else if (googleKey) {
        summaries = await geminiBatch(batch, googleKey);
      } else if (openaiBase) {
        summaries = await openaiCompatBatch(batch, openaiBase, openaiModel, openaiKey);
      } else {
        break; // No AI configured
      }
      summaries.forEach((s, j) => {
        if (s && batch[j]) batch[j].summary = s;
      });
    } catch {
      // AI failed — fall through to tier 3
    }
  }

  // Third pass: signature fallback for anything still missing
  for (const sym of symbols) {
    if (!sym.summary) sym.summary = signatureFallback(sym);
  }
}

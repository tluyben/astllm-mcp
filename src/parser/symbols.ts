import crypto from 'crypto';

export type SymbolKind = 'function' | 'class' | 'method' | 'type' | 'constant' | 'interface';

export interface CodeSymbol {
  id: string;
  file: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  signature: string;
  language: string;
  line: number;       // 1-indexed start line
  end_line: number;   // 1-indexed last line (= 0-indexed exclusive end)
  byte_offset: number;
  byte_length: number;
  docstring: string;
  summary: string;
  parent: string | null;
  decorators: string[];
  keywords: string[];
  content_hash: string;
}

export function makeSymbolId(filePath: string, qualifiedName: string, kind: SymbolKind): string {
  return `${filePath}::${qualifiedName}#${kind}`;
}

export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function disambiguateOverloads(symbols: CodeSymbol[]): CodeSymbol[] {
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();

  for (const sym of symbols) {
    counts.set(sym.id, (counts.get(sym.id) ?? 0) + 1);
  }

  return symbols.map(sym => {
    if ((counts.get(sym.id) ?? 0) <= 1) return sym;
    const n = (seen.get(sym.id) ?? 0) + 1;
    seen.set(sym.id, n);
    return { ...sym, id: `${sym.id}~${n}` };
  });
}

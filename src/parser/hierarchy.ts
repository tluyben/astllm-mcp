import { CodeSymbol } from './symbols.js';

export interface SymbolNode {
  symbol: CodeSymbol;
  children: SymbolNode[];
}

export function buildSymbolTree(symbols: CodeSymbol[]): SymbolNode[] {
  const nodeMap = new Map<string, SymbolNode>();
  for (const sym of symbols) {
    nodeMap.set(sym.id, { symbol: sym, children: [] });
  }

  const roots: SymbolNode[] = [];
  for (const sym of symbols) {
    const node = nodeMap.get(sym.id)!;
    if (sym.parent && nodeMap.has(sym.parent)) {
      nodeMap.get(sym.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function flattenTree(nodes: SymbolNode[], depth = 0): Array<[CodeSymbol, number]> {
  const result: Array<[CodeSymbol, number]> = [];
  for (const node of nodes) {
    result.push([node.symbol, depth]);
    result.push(...flattenTree(node.children, depth + 1));
  }
  return result;
}

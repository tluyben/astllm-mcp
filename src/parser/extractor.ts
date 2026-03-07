import path from 'path';
import { createRequire } from 'module';
import Parser from 'tree-sitter';
// Bun --compile: literal require()s in this CJS shim are statically traceable,
// ensuring all grammar packages are embedded in the binary bundle.
// @ts-ignore - bun uses .cts source; tsc compiles grammars.cts → grammars.cjs
import _grammarBundle from './grammars.cts';
import { CodeSymbol, SymbolKind, makeSymbolId, computeContentHash, disambiguateOverloads } from './symbols.js';
import { EXTENSION_TO_LANGUAGE, LANGUAGE_SPECS, LanguageSpec } from './languages.js';

const _require = createRequire(import.meta.url);

// Lazy-load tree-sitter language grammars (CJS packages via createRequire)
const loadedLanguages: Record<string, unknown> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _bundle = _grammarBundle as Record<string, any> | null;

function loadLanguage(lang: string): unknown {
  if (lang in loadedLanguages) return loadedLanguages[lang];
  try {
    switch (lang) {
      case 'python':
        loadedLanguages[lang] = _bundle?.python ?? _require('tree-sitter-python'); break;
      case 'javascript':
        loadedLanguages[lang] = _bundle?.javascript ?? _require('tree-sitter-javascript'); break;
      case 'typescript':
      case 'tsx': {
        const m = _bundle?.typescript ?? _require('tree-sitter-typescript');
        loadedLanguages['typescript'] = m?.typescript;
        loadedLanguages['tsx'] = m?.tsx;
        break;
      }
      case 'go':
        loadedLanguages[lang] = _bundle?.go ?? _require('tree-sitter-go'); break;
      case 'rust':
        loadedLanguages[lang] = _bundle?.rust ?? _require('tree-sitter-rust'); break;
      case 'java':
        loadedLanguages[lang] = _bundle?.java ?? _require('tree-sitter-java'); break;
      case 'php': {
        const m = _bundle?.php ?? _require('tree-sitter-php');
        loadedLanguages[lang] = m?.php ?? m;
        break;
      }
      case 'dart':
        loadedLanguages[lang] = _bundle?.dart ?? _require('tree-sitter-dart'); break;
      case 'csharp':
        loadedLanguages[lang] = _bundle?.csharp ?? _require('tree-sitter-c-sharp'); break;
      case 'c':
        loadedLanguages[lang] = _bundle?.c ?? _require('tree-sitter-c'); break;
      case 'cpp':
        loadedLanguages[lang] = _bundle?.cpp ?? _require('tree-sitter-cpp'); break;
      default:
        loadedLanguages[lang] = null;
    }
  } catch {
    loadedLanguages[lang] = null;
  }
  return loadedLanguages[lang] ?? null;
}

export function getLanguageForFile(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// ─── Docstring / comment extraction ─────────────────────────────────────────

function extractPythonDocstring(node: Parser.SyntaxNode): string {
  const body = node.childForFieldName('body');
  if (!body) return '';
  const first = body.firstNamedChild;
  if (!first || first.type !== 'expression_statement') return '';
  const str = first.firstNamedChild;
  if (!str || str.type !== 'string') return '';
  let t = str.text;
  if (t.startsWith('"""') || t.startsWith("'''")) t = t.slice(3, -3);
  else if (t.startsWith('"') || t.startsWith("'")) t = t.slice(1, -1);
  return t.trim();
}

function extractPrecedingComment(node: Parser.SyntaxNode, commentTypes: string[]): string {
  const comments: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev && commentTypes.includes(prev.type)) {
    comments.unshift(prev.text);
    prev = prev.previousNamedSibling;
  }
  return comments.join('\n');
}

function extractFirstChildComment(node: Parser.SyntaxNode, commentTypes: string[]): string {
  // Prefer preceding sibling comment
  let prev = node.previousSibling;
  while (prev) {
    if (commentTypes.includes(prev.type)) return prev.text;
    // Stop if we hit something that's not whitespace/newline
    if (prev.type !== 'empty_statement') break;
    prev = prev.previousSibling;
  }
  return '';
}

function extractDocstring(outerNode: Parser.SyntaxNode, spec: LanguageSpec): string {
  switch (spec.docstringStrategy) {
    case 'python_docstring': return extractPythonDocstring(outerNode);
    case 'preceding_comment': return extractPrecedingComment(outerNode, spec.commentTypes);
    case 'first_child_comment': return extractFirstChildComment(outerNode, spec.commentTypes);
  }
}

// ─── Decorators ──────────────────────────────────────────────────────────────

function extractDecorators(node: Parser.SyntaxNode, language: string): string[] {
  const decs: string[] = [];
  if (language === 'python') {
    let prev = node.previousNamedSibling;
    while (prev && prev.type === 'decorator') {
      decs.unshift(prev.text);
      prev = prev.previousNamedSibling;
    }
  } else if (language === 'typescript' || language === 'javascript' || language === 'tsx') {
    for (const child of node.namedChildren) {
      if (child.type === 'decorator') decs.push(child.text);
    }
  } else if (language === 'java') {
    let prev = node.previousNamedSibling;
    while (prev && (prev.type === 'annotation' || prev.type === 'marker_annotation')) {
      decs.unshift(prev.text);
      prev = prev.previousNamedSibling;
    }
  } else if (language === 'rust') {
    let prev = node.previousNamedSibling;
    while (prev && prev.type === 'attribute_item') {
      decs.unshift(prev.text);
      prev = prev.previousNamedSibling;
    }
  } else if (language === 'csharp') {
    for (const child of node.namedChildren) {
      if (child.type === 'attribute_list') decs.push(child.text);
    }
  }
  return decs;
}

// ─── Signature ───────────────────────────────────────────────────────────────

function buildSignature(node: Parser.SyntaxNode): string {
  const body = node.childForFieldName('body') ?? node.childForFieldName('block');
  if (body) {
    const beforeBody = node.text.substring(0, body.startIndex - node.startIndex);
    return beforeBody.replace(/\s+/g, ' ').trim().replace(/\{?\s*$/, '').trim();
  }
  return node.text.split('\n')[0].trim();
}

// ─── C/C++ name extraction ────────────────────────────────────────────────────

function extractCDeclaratorName(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'identifier': return node.text;
    case 'field_identifier': return node.text;
    case 'scoped_identifier': return node.text;
    case 'pointer_declarator':
    case 'reference_declarator':
    case 'function_declarator':
    case 'abstract_function_declarator': {
      const inner = node.childForFieldName('declarator');
      return inner ? extractCDeclaratorName(inner) : null;
    }
    default:
      if (node.namedChildCount > 0) return extractCDeclaratorName(node.namedChildren[0]);
      return null;
  }
}

function getSymbolName(node: Parser.SyntaxNode, spec: LanguageSpec, language: string): string | null {
  // C/C++ function definition: name is inside declarator
  if ((language === 'c' || language === 'cpp') && node.type === 'function_definition') {
    const decl = node.childForFieldName('declarator');
    return decl ? extractCDeclaratorName(decl) : null;
  }
  // C++ class/struct/namespace: use 'name' field directly
  if (language === 'cpp' && ['class_specifier', 'struct_specifier', 'namespace_definition'].includes(node.type)) {
    const nameNode = node.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }
  // C struct name
  if (language === 'c' && ['struct_specifier', 'enum_specifier'].includes(node.type)) {
    const nameNode = node.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }
  const nameNode =
    node.childForFieldName(spec.nameField) ??
    node.childForFieldName('name') ??
    node.childForFieldName('identifier');
  return nameNode ? nameNode.text : null;
}

// ─── Symbol builder ───────────────────────────────────────────────────────────

function buildSymbol(
  outerNode: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  filePath: string,
  language: string,
  spec: LanguageSpec,
  scope: string[],
  parentId: string | null,
  content: string,            // Full source string for char→byte offset conversion
): CodeSymbol {
  const sep = (language === 'rust' || language === 'go' || language === 'c' || language === 'cpp') ? '::' : '.';
  const qualifiedName = scope.length > 0 ? [...scope, name].join(sep) : name;
  const id = makeSymbolId(filePath, qualifiedName, kind);

  // tree-sitter startIndex/endIndex are CHARACTER indices in the source string.
  // Convert to UTF-8 byte offsets for correct on-disk file seeking.
  const byteOffset = Buffer.byteLength(content.slice(0, outerNode.startIndex), 'utf8');
  const byteLength = Buffer.byteLength(content.slice(outerNode.startIndex, outerNode.endIndex), 'utf8');

  return {
    id,
    file: filePath,
    name,
    qualified_name: qualifiedName,
    kind,
    signature: buildSignature(outerNode),
    language,
    line: outerNode.startPosition.row + 1,
    end_line: outerNode.endPosition.row + 1,
    byte_offset: byteOffset,
    byte_length: byteLength,
    docstring: extractDocstring(outerNode, spec),
    summary: '',
    parent: parentId,
    decorators: extractDecorators(outerNode, language),
    keywords: [],
    content_hash: computeContentHash(outerNode.text),
  };
}

// ─── AST walker ──────────────────────────────────────────────────────────────

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  language: string,
  spec: LanguageSpec,
  scope: string[],
  parentId: string | null,
  symbols: CodeSymbol[],
  content: string,            // Full source string for byte-offset conversion
): void {
  // ── Python: decorated definitions wrap the actual function/class ──────────
  if (language === 'python' && node.type === 'decorated_definition') {
    const inner = node.lastNamedChild;
    if (inner) {
      const innerKind = spec.symbolNodeTypes[inner.type] as SymbolKind | undefined;
      const name = innerKind ? getSymbolName(inner, spec, language) : null;
      if (innerKind && name) {
        // Use outer node for byte range (includes decorators), inner for name/body
        const sym = buildSymbol(node, name, innerKind, filePath, language, spec, scope, parentId, content);
        symbols.push(sym);
        if (spec.containerTypes.includes(inner.type)) {
          for (const child of inner.namedChildren) {
            walkNode(child, filePath, language, spec, [...scope, name], sym.id, symbols, content);
          }
        }
        return;
      }
    }
  }

  // ── Go: type_declaration wraps one or more type_spec nodes ────────────────
  if (language === 'go' && node.type === 'type_declaration') {
    for (const child of node.namedChildren) {
      if (child.type === 'type_spec') {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        if (nameNode) {
          let kind: SymbolKind = 'type';
          if (typeNode?.type === 'interface_type') kind = 'interface';
          else if (typeNode?.type === 'struct_type') kind = 'class';
          const sym = buildSymbol(child, nameNode.text, kind, filePath, language, spec, scope, parentId, content);
          symbols.push(sym);
        }
      }
    }
    return;
  }

  // ── Rust: impl_item — emit a class symbol, recurse with updated scope ──────
  if (language === 'rust' && node.type === 'impl_item') {
    const traitNode = node.childForFieldName('trait');
    const typeNode = node.childForFieldName('type');
    const implName = typeNode ? typeNode.text : 'impl';
    const sym = buildSymbol(node, implName, 'class', filePath, language, spec, scope, parentId, content);
    symbols.push(sym);
    for (const child of node.namedChildren) {
      walkNode(child, filePath, language, spec, [...scope, implName], sym.id, symbols, content);
    }
    return;
  }

  // ── JS/TS: arrow functions / function expressions in variable declarations ──
  if (spec.specialHandling === 'js_arrow' &&
    (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
    for (const decl of node.namedChildren) {
      if (decl.type === 'variable_declarator') {
        const nameNode = decl.childForFieldName('name');
        const valueNode = decl.childForFieldName('value');
        if (nameNode && valueNode &&
          (valueNode.type === 'arrow_function' ||
            valueNode.type === 'function_expression' ||
            valueNode.type === 'generator_function')) {
          const sym = buildSymbol(decl, nameNode.text, 'function', filePath, language, spec, scope, parentId, content);
          symbols.push(sym);
        }
      }
    }
    // Fall through to also handle regular declarations inside
  }

  // ── Generic symbol node types ─────────────────────────────────────────────
  const kind = spec.symbolNodeTypes[node.type] as SymbolKind | undefined;
  if (kind !== undefined) {
    const name = getSymbolName(node, spec, language);
    if (name) {
      const sym = buildSymbol(node, name, kind, filePath, language, spec, scope, parentId, content);
      symbols.push(sym);

      // Recurse into containers with updated scope
      if (spec.containerTypes.includes(node.type)) {
        for (const child of node.namedChildren) {
          walkNode(child, filePath, language, spec, [...scope, name], sym.id, symbols, content);
        }
        return;
      }

      // Non-container symbols: still recurse for nested classes (e.g. inner classes in Java)
      for (const child of node.namedChildren) {
        walkNode(child, filePath, language, spec, scope, parentId, symbols, content);
      }
      return;
    }
  }

  // ── Default: recurse without scope change ─────────────────────────────────
  for (const child of node.namedChildren) {
    walkNode(child, filePath, language, spec, scope, parentId, symbols, content);
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function parseFile(content: string, filename: string, language?: string): CodeSymbol[] {
  const lang = language ?? getLanguageForFile(filename);
  if (!lang) return [];

  const spec = LANGUAGE_SPECS[lang];
  if (!spec) return [];

  const langModule = loadLanguage(lang);
  if (!langModule) return [];

  try {
    const parser = new Parser();
    parser.setLanguage(langModule as Parameters<typeof parser.setLanguage>[0]);
    const tree = parser.parse(content);

    // For C++ header files, try C if parse quality is poor
    if ((lang === 'c' || lang === 'cpp') && filename.endsWith('.h')) {
      const cppErrors = countErrors(tree.rootNode);
      if (cppErrors > 3 && lang === 'cpp') {
        const cLang = loadLanguage('c');
        if (cLang) {
          const cParser = new Parser();
          cParser.setLanguage(cLang as Parameters<typeof cParser.setLanguage>[0]);
          const cTree = cParser.parse(content);
          if (countErrors(cTree.rootNode) < cppErrors) {
            const cSpec = LANGUAGE_SPECS['c'];
            const cSymbols: CodeSymbol[] = [];
            walkNode(cTree.rootNode, filename, 'c', cSpec, [], null, cSymbols, content);
            return disambiguateOverloads(cSymbols);
          }
        }
      }
    }

    const symbols: CodeSymbol[] = [];
    walkNode(tree.rootNode, filename, lang, spec, [], null, symbols, content);
    return disambiguateOverloads(symbols);
  } catch {
    return [];
  }
}

function countErrors(node: Parser.SyntaxNode): number {
  let count = node.type === 'ERROR' ? 1 : 0;
  for (const child of node.children) {
    count += countErrors(child);
  }
  return count;
}

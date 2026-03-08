import { SymbolKind } from './symbols.js';

export interface LanguageSpec {
  extensions: string[];
  symbolNodeTypes: Partial<Record<string, SymbolKind>>;
  nameField: string;
  containerTypes: string[];
  docstringStrategy: 'python_docstring' | 'preceding_comment' | 'first_child_comment';
  commentTypes: string[];
  parameterField?: string;
  returnTypeField?: string;
  specialHandling?: 'js_arrow' | 'go_types' | 'rust_impl' | 'cpp_scoped';
}

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.php': 'php',
  '.dart': 'dart',
  '.swift': 'swift',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
};

export const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  python: {
    extensions: ['.py'],
    symbolNodeTypes: {
      function_definition: 'function',
      class_definition: 'class',
      decorated_definition: 'function',
    },
    nameField: 'name',
    containerTypes: ['class_definition'],
    docstringStrategy: 'python_docstring',
    commentTypes: ['comment'],
    parameterField: 'parameters',
  },
  javascript: {
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    symbolNodeTypes: {
      function_declaration: 'function',
      class_declaration: 'class',
      method_definition: 'method',
      generator_function_declaration: 'function',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'class_body'],
    docstringStrategy: 'first_child_comment',
    commentTypes: ['comment'],
    parameterField: 'parameters',
    specialHandling: 'js_arrow',
  },
  typescript: {
    extensions: ['.ts', '.mts', '.cts'],
    symbolNodeTypes: {
      function_declaration: 'function',
      class_declaration: 'class',
      method_definition: 'method',
      generator_function_declaration: 'function',
      interface_declaration: 'interface',
      type_alias_declaration: 'type',
      enum_declaration: 'class',
      abstract_class_declaration: 'class',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'class_body', 'abstract_class_declaration', 'interface_declaration', 'enum_declaration'],
    docstringStrategy: 'first_child_comment',
    commentTypes: ['comment'],
    parameterField: 'parameters',
    specialHandling: 'js_arrow',
  },
  tsx: {
    extensions: ['.tsx'],
    symbolNodeTypes: {
      function_declaration: 'function',
      class_declaration: 'class',
      method_definition: 'method',
      interface_declaration: 'interface',
      type_alias_declaration: 'type',
      enum_declaration: 'class',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'class_body', 'interface_declaration', 'enum_declaration'],
    docstringStrategy: 'first_child_comment',
    commentTypes: ['comment'],
    specialHandling: 'js_arrow',
  },
  go: {
    extensions: ['.go'],
    symbolNodeTypes: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'type',
    },
    nameField: 'name',
    containerTypes: [],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment'],
    parameterField: 'parameters',
    specialHandling: 'go_types',
  },
  rust: {
    extensions: ['.rs'],
    symbolNodeTypes: {
      function_item: 'function',
      struct_item: 'type',
      enum_item: 'type',
      trait_item: 'interface',
      type_item: 'type',
      impl_item: 'class',
    },
    nameField: 'name',
    containerTypes: ['impl_item', 'trait_item'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['line_comment', 'block_comment'],
    parameterField: 'parameters',
    specialHandling: 'rust_impl',
  },
  java: {
    extensions: ['.java'],
    symbolNodeTypes: {
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      constructor_declaration: 'function',
      enum_declaration: 'class',
      annotation_type_declaration: 'type',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'class_body', 'interface_body', 'enum_body'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['block_comment', 'line_comment'],
    parameterField: 'formal_parameters',
  },
  php: {
    extensions: ['.php'],
    symbolNodeTypes: {
      function_definition: 'function',
      class_declaration: 'class',
      method_declaration: 'method',
      interface_declaration: 'interface',
      trait_declaration: 'class',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'interface_declaration', 'trait_declaration', 'declaration_list'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment', 'doc_comment'],
    parameterField: 'parameters',
  },
  dart: {
    extensions: ['.dart'],
    symbolNodeTypes: {
      function_signature: 'function',    // top-level functions and methods (via method_signature recursion)
      class_definition: 'class',         // classes and abstract classes
      enum_declaration: 'type',          // enums
      mixin_declaration: 'class',        // mixins (name extracted via identifier child)
    },
    nameField: 'name',
    containerTypes: ['class_definition', 'class_body', 'mixin_declaration'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment', 'documentation_comment'],
    parameterField: 'formal_parameter_list',
  },
  swift: {
    extensions: ['.swift'],
    symbolNodeTypes: {
      function_declaration: 'function',         // free functions and methods
      class_declaration: 'class',               // classes, structs, enums, extensions
      protocol_declaration: 'interface',        // protocols
      protocol_function_declaration: 'method',  // protocol method requirements
      init_declaration: 'function',             // initializers
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'class_body', 'protocol_declaration', 'protocol_body', 'enum_class_body'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment', 'multiline_comment'],
    parameterField: 'params',
  },
  csharp: {
    extensions: ['.cs'],
    symbolNodeTypes: {
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      constructor_declaration: 'function',
      struct_declaration: 'type',
      enum_declaration: 'class',
      record_declaration: 'class',
      delegate_declaration: 'type',
    },
    nameField: 'name',
    containerTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'declaration_list'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment', 'doc_comment'],
    parameterField: 'parameter_list',
  },
  c: {
    extensions: ['.c', '.h'],
    symbolNodeTypes: {
      function_definition: 'function',
      struct_specifier: 'type',
      enum_specifier: 'type',
      type_definition: 'type',
    },
    nameField: 'declarator',
    containerTypes: ['struct_specifier'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment'],
    parameterField: 'parameters',
  },
  cpp: {
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    symbolNodeTypes: {
      function_definition: 'function',
      class_specifier: 'class',
      struct_specifier: 'type',
      namespace_definition: 'class',
      template_declaration: 'function',
      type_definition: 'type',
    },
    nameField: 'name',
    containerTypes: ['class_specifier', 'struct_specifier', 'namespace_definition', 'field_declaration_list'],
    docstringStrategy: 'preceding_comment',
    commentTypes: ['comment'],
    parameterField: 'parameters',
    specialHandling: 'cpp_scoped',
  },
};

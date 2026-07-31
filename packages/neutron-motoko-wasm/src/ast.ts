export type CompilerAST = CompilerAST[] | CompilerNode | string | null;

export type RawExp = unknown & {
  readonly __brand: "RawExp";
};

export type RawScope = unknown & {
  readonly __brand: "RawScope";
};

export interface CompilerNode {
  name: string;
  args: CompilerAST[];
  rawExp?: RawExp;
}

export type Span = [number, number];
export type AST = AST[] | Node | string | null;

export interface Source {
  file: string;
  start: Span;
  end: Span;
}

export interface Node extends Partial<Source> {
  parent?: Node | undefined;
  name: string;
  rawExp?: RawExp;
  type?: string;
  typeRep?: Node;
  doc?: string;
  declaration?: Source;
  args?: AST[];
}

export function getRawExp(node: Node): RawExp | undefined {
  return node.rawExp;
}

export function setRootScope(node: Node, scope: RawScope): void {
  Object.defineProperty(node, "rawScope", {
    value: scope,
    enumerable: false,
  });
}

export function getScope(ast: AST): RawScope | undefined {
  return typeof ast === "object" && ast !== null && !Array.isArray(ast)
    ? ((ast as Node & { rawScope?: RawScope }).rawScope)
    : undefined;
}

export function asNode(ast: AST | undefined): Node | undefined {
  if (ast && typeof ast === "object" && !Array.isArray(ast)) {
    return ast;
  }
}

const nodesThatNeedParentProperties = ["ID", "ExpField"];

export function simplifyAST(ast: CompilerNode, parent?: Node | undefined): Node;
export function simplifyAST(
  ast: CompilerAST[],
  parent?: Node | undefined
): AST[];
export function simplifyAST<T extends CompilerAST>(
  ast: T,
  parent?: Node | undefined
): T;
export function simplifyAST(
  ast: CompilerAST,
  parent?: Node | undefined
): AST {
  if (Array.isArray(ast)) {
    return ast.map((a) => simplifyAST(a, parent));
  }
  if (typeof ast !== "object" || ast === null) {
    return ast;
  }
  if (ast.name === "@") {
    const [start, end, subAst] = ast.args as [CompilerNode, CompilerNode, CompilerAST];
    const node =
      typeof subAst === "string"
        ? ({ name: subAst, parent } as Node)
        : (simplifyAST(subAst, parent) as Node);
    node.start = [+String(start.args[1]), +String(start.args[2])];
    node.end = [+String(end.args[1]), +String(end.args[2])];
    const file = start.args[0];
    if (typeof file === "string" && file.length > 0) node.file = file;
    return node;
  }
  if (ast.name === "@@") {
    const [file, start, end] = ast.args as [string, CompilerNode, CompilerNode];
    return {
      name: "Region",
      file,
      start: [+String(start.args[0]), +String(start.args[1])],
      end: [+String(end.args[0]), +String(end.args[1])],
    };
  }
  if (ast.name === ":") {
    const [typeAst = null, type, typeRep = null] = ast.args;
    const node =
      typeof typeAst === "string"
        ? ({ name: typeAst, parent } as Node)
        : (simplifyAST(typeAst, parent) as Node);
    if (typeof type === "string") node.type = type;
    node.typeRep = simplifyAST(typeRep, parent) as Node;
    return node;
  }
  if (ast.name === "*") {
    const [doc, docAst = null] = ast.args;
    const node =
      typeof docAst === "string"
        ? ({ name: docAst, parent } as Node)
        : (simplifyAST(docAst, parent) as Node);
    if (typeof doc === "string") node.doc = doc;
    return node;
  }

  const node: Node = { name: ast.name };
  Object.defineProperty(node, "rawExp", {
    value: ast.rawExp,
    enumerable: false,
  });
  Object.defineProperty(node, "parent", {
    value: parent,
    enumerable: false,
  });
  node.args = simplifyAST(ast.args, node);

  if (parent && nodesThatNeedParentProperties.includes(ast.name)) {
    Object.defineProperty(node, "type", {
      get: () => parent.type,
      set: (newType) => {
        parent.type = newType;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(node, "typeRep", {
      get: () => parent.typeRep,
      set: (newTypeRep) => {
        parent.typeRep = newTypeRep;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(node, "doc", {
      get: () => parent.doc,
      set: (newDoc) => {
        parent.doc = newDoc;
      },
      enumerable: true,
      configurable: true,
    });
  }

  return node;
}

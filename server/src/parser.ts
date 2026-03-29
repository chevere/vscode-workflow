/**
 * Parses PHP source to find chevere/workflow function calls using a proper AST
 * (php-parser / glayzzle) instead of fragile regex.
 *
 * Handles correctly:
 *   - workflow(jobName: sync(new ClassName(), arg: value), ...)
 *   - workflow(jobName: async(ClassName::class, arg: value), ...)
 *   - response('jobName') references anywhere in the file
 *   - use statements and aliased imports
 *   - Strings, comments, heredocs (ignored by the AST, never confused with calls)
 */

import { AttrInfo, ClassSignature, ParamInfo } from './reflector';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PhpParser = require('php-parser') as new (opts: unknown) => {
  parseCode(source: string, filename: string): unknown;
};

// ─── Shared engine instance ──────────────────────────────────────────────────
const engine = new PhpParser({
  parser: { extractDoc: true, suppressErrors: true },
  ast: { withPositions: true },
});

// ─── Public interfaces (unchanged — consumers depend on these) ────────────────

export interface JobCallArg {
  name: string;        // empty string for positional args
  positional: boolean;
  value: string;
  /** character offset of the argument value in the document */
  valueOffset: number;
  /** character offset of the argument name (same as valueOffset for positional) */
  nameOffset: number;
  /**
   * Statically resolved PHP type of the value, or null when it can't be
   * determined at parse time (e.g. variable(), response(), arbitrary expressions).
   */
  resolvedType: string | null;
  /**
   * The actual literal value (string, number, boolean, null), or undefined
   * for runtime values that can't be determined statically.
   */
  resolvedValue: string | number | boolean | null | undefined;
  /**
   * When the argument value is response('jobName') or response('jobName', 'key'),
   * this holds the referenced job name and optional key so diagnostics can
   * compare the job's return type (or a specific array key type) against the
   * expected parameter type.
   */
  responseJobRef?: { jobName: string; key?: string };
}

/**
 * Arguments passed to withRunIf(), withRunIfNot(), or withDepends() in a job
 * method chain. Each entry holds the chain method name and the offsets of its
 * arguments, so diagnostics can point to the right location in the document.
 */
export interface ChainMethodArg {
  /** 'withRunIf', 'withRunIfNot', or 'withDepends' */
  method: string;
  /** character offset of the argument value */
  valueOffset: number;
  /** raw source text of the argument */
  value: string;
  /** response() job reference if the argument is a response() call */
  responseJobRef?: { jobName: string; key?: string };
  /** variable() name if the argument is a variable() call */
  variableName?: string;
  /** string literal value if the argument is a plain string (e.g. withDepends job names) */
  stringValue?: string;
}

export interface JobCall {
  kind: 'sync' | 'async';
  className: string;
  /** Method name for array callables like [$this, 'method'] or [Class::class, 'method']. */
  methodName?: string;
  /** Pre-resolved signature for inline closures (arrowfunc/closure AST nodes). */
  closureSignature?: ClassSignature;
  args: JobCallArg[];
  callStart: number;
  callEnd: number;
  jobName?: string;
  /** FQCN of the class containing the workflow() call, if determinable. */
  enclosingClass?: string;
  /** Arguments from withRunIf() / withRunIfNot() chain calls, if any. */
  chainMethodArgs?: ChainMethodArg[];
}

export interface WorkflowCall {
  jobs: { name: string; call: JobCall }[];
  callStart: number;
  callEnd: number;
  /** FQCN of the class containing this workflow() call, if determinable. */
  enclosingClass?: string;
}

export interface ResponseRef {
  jobName: string;
  offset: number;
}

export interface VariableRef {
  name: string;
  /** character offset of the variable() call start */
  offset: number;
  /** character length of the full variable() call, e.g. variable('my_var') */
  length: number;
}

export interface ParsedDocument {
  workflowCalls: WorkflowCall[];
  responseRefs: ResponseRef[];
  variableRefs: VariableRef[];
  useMap: Map<string, string>;
  /** FQCN of the class that declares a static workflow() method, if any */
  workflowClassName?: string;
  /** Raw PHP source that was parsed */
  source: string;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseDocument(source: string): ParsedDocument {
  let ast: any;
  try {
    ast = engine.parseCode(source, 'doc.php');
  } catch {
    return { workflowCalls: [], responseRefs: [], variableRefs: [], useMap: new Map(), source };
  }

  // With a namespace declaration, use statements are nested inside the namespace node
  const topNodes: any[] = ast.children ?? [];
  const nsNode = topNodes.find((n: any) => n.kind === 'namespace');
  // Validate the namespace against the PHP namespace character set before storing it.
  // PHP namespaces may only contain identifier characters and backslash separators.
  // Any other character (semicolons, newlines, etc.) is structurally impossible in a
  // valid namespace and indicates a malicious or malformed value that must not be
  // embedded into dynamically-generated PHP scripts.
  const rawNamespace: string = nsNode?.name ?? '';
  const fileNamespace: string = /^[A-Za-z_][A-Za-z0-9_\\]*$/.test(rawNamespace) ? rawNamespace : '';
  const scopeNodes: any[] = nsNode?.children ?? topNodes;

  const useMap = collectUseMap(scopeNodes, fileNamespace);
  const workflowLocalNames = collectWorkflowLocalNames(scopeNodes);
  const workflowCalls: WorkflowCall[] = [];
  const responseRefs: ResponseRef[] = [];
  const variableRefs: VariableRef[] = [];

  walkNode(ast, source, useMap, workflowCalls, responseRefs, variableRefs, null, workflowLocalNames);

  const workflowClassName = findWorkflowClassName(ast, useMap);

  return { workflowCalls, responseRefs, variableRefs, useMap, workflowClassName, source };
}

// ─── Use-statement map ────────────────────────────────────────────────────────

function collectUseMap(nodes: any[], fileNamespace: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== 'usegroup') continue;
    // Only class imports — skip `use function` and `use const`
    if (node.type === 'function' || node.type === 'const') continue;
    for (const item of node.items ?? []) {
      const fqcn: string = item.name;
      const alias: string = item.alias?.name ?? fqcn.split('\\').pop()!;
      map.set(alias, fqcn);
    }
  }
  // Store the file namespace so unqualified names without a `use` can be resolved
  if (fileNamespace) {
    map.set('__namespace__', fileNamespace);
  }
  return map;
}

/**
 * Collects the local names under which `Chevere\Workflow\workflow` can be
 * called in this file. Includes 'workflow' (bare/FQ) plus any alias declared
 * via `use function Chevere\Workflow\workflow as <alias>;`.
 */
function collectWorkflowLocalNames(nodes: any[]): Set<string> {
  const names = new Set<string>(['workflow']);
  for (const node of nodes) {
    if (node.kind !== 'usegroup' || node.type !== 'function') continue;
    for (const item of node.items ?? []) {
      const fqfn: string = item.name;
      if (fqfn === 'Chevere\\Workflow\\workflow') {
        names.add(item.alias?.name ?? 'workflow');
      }
    }
  }
  return names;
}

// ─── AST walker ───────────────────────────────────────────────────────────────

function walkNode(
  node: any,
  source: string,
  useMap: Map<string, string>,
  workflowCalls: WorkflowCall[],
  responseRefs: ResponseRef[],
  variableRefs: VariableRef[],
  enclosingClass: string | null = null,
  workflowLocalNames: Set<string> = new Set(['workflow']),
  depth = 0
): void {
  if (depth > 500) return;
  if (!node || typeof node !== 'object' || !node.kind) return;

  // Track class scope so $this can be resolved inside methods
  if (node.kind === 'class') {
    const rawName: string = typeof node.name === 'string' ? node.name : (node.name?.name ?? '');
    if (rawName) {
      const ns = useMap.get('__namespace__');
      const classFqcn = ns ? `${ns}\\${rawName}` : rawName;
      for (const member of node.body ?? []) {
        walkNode(member, source, useMap, workflowCalls, responseRefs, variableRefs, classFqcn, workflowLocalNames, depth + 1);
      }
      return;
    }
  }

  if (node.kind === 'call') {
    const name = callName(node);

    const isWorkflow = name !== null && (
      workflowLocalNames.has(name) ||
      name === 'Chevere\\Workflow\\workflow'
    );

    if (isWorkflow) {
      const wCall = parseWorkflowCall(node, source, useMap, enclosingClass);
      if (wCall) workflowCalls.push(wCall);
      // Recurse into sync/async arg values to catch response() refs inside
      for (const arg of node.arguments ?? []) {
        if (arg.kind === 'namedargument' && arg.value?.kind === 'call') {
          for (const inner of arg.value.arguments ?? []) {
            walkNode(inner, source, useMap, workflowCalls, responseRefs, variableRefs, enclosingClass, workflowLocalNames, depth + 1);
          }
        }
      }
      return;
    }

    if (name === 'response') {
      const ref = parseResponseRef(node);
      if (ref) responseRefs.push(ref);
      return;
    }

    if (name === 'variable') {
      const ref = parseVariableRef(node);
      if (ref) variableRefs.push(ref);
      return;
    }
  }

  // Generic recursion for all other node types
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        walkNode(item, source, useMap, workflowCalls, responseRefs, variableRefs, enclosingClass, workflowLocalNames, depth + 1);
      }
    } else if (child && typeof child === 'object' && child.kind) {
      walkNode(child, source, useMap, workflowCalls, responseRefs, variableRefs, enclosingClass, workflowLocalNames, depth + 1);
    }
  }
}

// ─── workflow() call ──────────────────────────────────────────────────────────

function parseWorkflowCall(
  node: any,
  source: string,
  useMap: Map<string, string>,
  enclosingClass: string | null = null
): WorkflowCall | null {
  const jobs: WorkflowCall['jobs'] = [];

  for (const arg of node.arguments ?? []) {
    if (arg.kind !== 'namedargument') continue;

    const jobName: string = arg.name;
    let callNode = arg.value;
    // Collect withRunIf/withRunIfNot chain args while unwinding the method chain.
    // The AST for a()->b() is: call { what: propertylookup { what: a_call } }
    const collectedChainArgs: ChainMethodArg[] = [];
    while (callNode?.kind === 'call' && callNode.what?.kind === 'propertylookup') {
      const methodNameNode = callNode.what.offset;
      const chainMethod: string =
        typeof methodNameNode === 'string' ? methodNameNode : (methodNameNode?.name ?? '');
      if (chainMethod === 'withRunIf' || chainMethod === 'withRunIfNot' || chainMethod === 'withDepends') {
        for (const chainArgNode of callNode.arguments ?? []) {
          const argValNode = chainArgNode.kind === 'namedargument' ? chainArgNode.value : chainArgNode;
          if (!argValNode?.loc) continue;
          collectedChainArgs.push({
            method: chainMethod,
            value: source.slice(argValNode.loc.start.offset, argValNode.loc.end.offset),
            valueOffset: argValNode.loc.start.offset,
            responseJobRef: resolveResponseJobRef(argValNode),
            variableName: resolveVariableName(argValNode),
            stringValue: argValNode.kind === 'string' ? (argValNode.value as string) : undefined,
          });
        }
      }
      callNode = callNode.what.what;
    }
    if (callNode?.kind !== 'call') continue;

    const kind = callName(callNode);
    if (kind !== 'sync' && kind !== 'async') continue;

    const callArgs: any[] = callNode.arguments ?? [];
    if (callArgs.length === 0) continue;

    const { className: resolvedClass, methodName } = resolveCallable(callArgs[0], useMap, enclosingClass);
    const className = resolvedClass ?? '<closure>';
    const closureSignature = className === '<closure>'
      ? resolveClosureSignature(callArgs[0], source, useMap) ?? undefined
      : undefined;

    const jobArgs: JobCallArg[] = [];
    for (let i = 1; i < callArgs.length; i++) {
      const a = callArgs[i];
      if (a.kind === 'namedargument') {
        if (!a.value?.loc) continue;
        jobArgs.push({
          name: a.name,
          positional: false,
          value: source.slice(a.value.loc.start.offset, a.value.loc.end.offset),
          nameOffset: a.loc.start.offset,
          valueOffset: a.value.loc.start.offset,
          resolvedType: resolveValueType(a.value, useMap),
          resolvedValue: resolveValueLiteral(a.value),
          responseJobRef: resolveResponseJobRef(a.value),
        });
      } else {
        jobArgs.push({
          name: '',
          positional: true,
          value: source.slice(a.loc.start.offset, a.loc.end.offset),
          nameOffset: a.loc.start.offset,
          valueOffset: a.loc.start.offset,
          resolvedType: resolveValueType(a, useMap),
          resolvedValue: resolveValueLiteral(a),
          responseJobRef: resolveResponseJobRef(a),
        });
      }
    }

    jobs.push({
      name: jobName,
      call: {
        kind: kind as 'sync' | 'async',
        className,
        methodName: methodName ?? undefined,
        closureSignature,
        args: jobArgs,
        callStart: callNode.loc.start.offset,
        callEnd: callNode.loc.end.offset,
        jobName,
        enclosingClass: enclosingClass ?? undefined,
        chainMethodArgs: collectedChainArgs.length > 0 ? collectedChainArgs : undefined,
      },
    });
  }

  if (jobs.length === 0) return null;

  return {
    jobs,
    callStart: node.loc.start.offset,
    callEnd: node.loc.end.offset,
    enclosingClass: enclosingClass ?? undefined,
  };
}

// ─── response() ref ───────────────────────────────────────────────────────────

function parseResponseRef(node: any): ResponseRef | null {
  const firstArg = node.arguments?.[0];
  if (firstArg?.kind !== 'string') return null;
  return {
    jobName: firstArg.value as string,
    offset: node.loc.start.offset,
  };
}

// ─── variable() ref ───────────────────────────────────────────────────────────

function parseVariableRef(node: any): VariableRef | null {
  const firstArg = node.arguments?.[0];
  if (firstArg?.kind !== 'string') return null;
  if (!node.loc) return null;
  return {
    name: firstArg.value as string,
    offset: node.loc.start.offset,
    length: node.loc.end.offset - node.loc.start.offset,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determines the PHP type of an argument value node from the AST.
 * Returns null for runtime values (variable(), response()) or expressions
 * whose type cannot be determined statically.
 */
function resolveValueType(node: any, useMap: Map<string, string>): string | null {
  if (!node) return null;
  switch (node.kind) {
    case 'new':
      return resolveNameNode(node.what, useMap);
    case 'number':
      return Number.isInteger(Number(node.value)) ? 'int' : 'float';
    case 'unary':
      if ((node.type === '-' || node.type === '+') && node.what?.kind === 'number')
        return Number.isInteger(Number(node.what.value)) ? 'int' : 'float';
      return null;
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'nullkeyword':
      return 'null';
    case 'call': {
      const name = callName(node);
      // workflow runtime helpers — type not statically known
      if (name === 'variable' || name === 'response' || name === 'sync' || name === 'async') {
        return null;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * If the node is a variable('name') call, returns the variable name; otherwise undefined.
 */
function resolveVariableName(node: any): string | undefined {
  if (node?.kind !== 'call') return undefined;
  if (callName(node) !== 'variable') return undefined;
  const firstArg = node.arguments?.[0];
  if (firstArg?.kind !== 'string') return undefined;
  return firstArg.value as string;
}

/**
 * If the node is a response('jobName') call, returns the job name; otherwise undefined.
 */
function resolveResponseJobRef(node: any): { jobName: string; key?: string } | undefined {
  if (node?.kind !== 'call') return undefined;
  if (callName(node) !== 'response') return undefined;
  const firstArg = node.arguments?.[0];
  if (firstArg?.kind !== 'string') return undefined;
  const jobName = firstArg.value as string;
  const secondArg = node.arguments?.[1];
  const key = secondArg?.kind === 'string' ? (secondArg.value as string) : undefined;
  return { jobName, key };
}

/**
 * Extracts the actual literal value from an AST node, or undefined if the
 * value cannot be determined statically (runtime expressions, objects, etc.).
 */
function resolveValueLiteral(node: any): string | number | boolean | null | undefined {
  if (!node) return undefined;
  switch (node.kind) {
    case 'string': return node.value as string;
    case 'number': return Number(node.value);
    case 'boolean': return node.value as boolean;
    case 'nullkeyword': return null;
    case 'unary':
      if (node.type === '-' && node.what?.kind === 'number') return -Number(node.what.value);
      if (node.type === '+' && node.what?.kind === 'number') return Number(node.what.value);
      return undefined;
    default: return undefined;
  }
}

/**
 * Builds an AttrInfo from a php-parser `attribute` AST node.
 * Returns null if the node can't be resolved (e.g. unknown attribute class).
 */
function resolveAttrInfo(attrNode: any, useMap: Map<string, string>, source?: string): AttrInfo | null {
  if (attrNode.kind !== 'attribute') return null;
  // attrNode.name is a plain string from the lexer (e.g. '_string' or 'Ns\_string')
  const rawName: string = typeof attrNode.name === 'string' ? attrNode.name : (attrNode.name?.name ?? '');
  if (!rawName) return null;
  const shortName = rawName.includes('\\') ? rawName.split('\\').pop()! : rawName;
  // If already qualified, use as-is (strip leading \); otherwise resolve via useMap
  const fqcn = rawName.includes('\\')
    ? (rawName.startsWith('\\') ? rawName.slice(1) : rawName)
    : (useMap.get(rawName) ?? rawName);

  // For display, use the original raw source text (short names, as the user wrote it)
  const rawForDisplay = (source && attrNode.loc)
    ? source.slice(attrNode.loc.start.offset, attrNode.loc.end.offset)
    : null;
  const display = rawForDisplay ? `#[${rawForDisplay}]` : `#[${shortName}]`;

  const args: Record<string, unknown> = {};
  for (let i = 0; i < (attrNode.args ?? []).length; i++) {
    const argNode = attrNode.args[i];
    const val = resolveValueLiteral(argNode.kind === 'namedargument' ? argNode.value : argNode);
    if (val !== undefined) {
      const key = argNode.kind === 'namedargument' ? argNode.name : String(i);
      args[key] = val;
    }
  }
  return { class: fqcn, shortName, args, display };
}

/** Returns the unqualified function/method name from a call's `what` node. */
function callName(node: any): string | null {
  return node.what?.kind === 'name' ? (node.what.name as string) : null;
}

/**
 * Resolves the class name and optional method name from the first argument of sync/async.
 * Supports `new ClassName()`, `ClassName::class`, and array callables like
 * `[$this, 'method']`, `[ClassName::class, 'method']`, `['ClassName', 'method']`.
 */
function resolveCallable(
  node: any,
  useMap: Map<string, string>,
  enclosingClass: string | null
): { className: string | null; methodName: string | null } {
  if (node.kind === 'new') {
    return { className: resolveNameNode(node.what, useMap), methodName: null };
  }
  if (node.kind === 'staticlookup' && node.offset?.name === 'class') {
    return { className: resolveNameNode(node.what, useMap), methodName: null };
  }
  // Array callable: [$this, 'method'], [ClassName::class, 'method'], ['ClassName', 'method']
  if (node.kind === 'array' && (node.items?.length === 2)) {
    const firstVal = node.items[0]?.value ?? node.items[0];
    const secondVal = node.items[1]?.value ?? node.items[1];
    if (secondVal?.kind !== 'string') return { className: null, methodName: null };
    const methodName: string = secondVal.value as string;
    // [$this, 'method'] — resolve to the enclosing class
    if (firstVal?.kind === 'variable' && firstVal.name === 'this') {
      return { className: enclosingClass, methodName };
    }
    // [ClassName::class, 'method']
    if (firstVal?.kind === 'staticlookup' && firstVal.offset?.name === 'class') {
      return { className: resolveNameNode(firstVal.what, useMap), methodName };
    }
    // ['ClassName', 'method']
    if (firstVal?.kind === 'string') {
      const raw: string = firstVal.value as string;
      const className = useMap.has(raw)
        ? useMap.get(raw)!
        : (useMap.get('__namespace__') ? `${useMap.get('__namespace__')}\\${raw}` : raw);
      return { className, methodName };
    }
  }
  return { className: null, methodName: null };
}

/**
 * Scans the top-level class declarations for one that has a public static
 * method named `workflow`. Returns the FQCN (namespace\ClassName) if found.
 */
function findWorkflowClassName(ast: any, useMap: Map<string, string>): string | undefined {
  const topNodes: any[] = ast.children ?? [];
  const nsNode = topNodes.find((n: any) => n.kind === 'namespace');
  const scopeNodes: any[] = nsNode?.children ?? topNodes;

  for (const node of scopeNodes) {
    if (node.kind !== 'class') continue;
    const rawName: string = typeof node.name === 'string' ? node.name : (node.name?.name ?? '');
    if (!rawName) continue;

    const hasStaticWorkflow = (node.body ?? []).some((member: any) => {
      if (member.kind !== 'method') return false;
      const methodName: string =
        typeof member.name === 'string' ? member.name : (member.name?.name ?? '');
      return methodName === 'workflow' && member.isStatic;
    });

    if (hasStaticWorkflow) {
      const ns = useMap.get('__namespace__');
      return ns ? `${ns}\\${rawName}` : rawName;
    }
  }
  return undefined;
}

/**
 * Resolves a type AST node to a string representation.
 */
function resolveTypeNode(node: any, useMap: Map<string, string>): string | null {
  if (!node) return null;
  switch (node.kind) {
    case 'typereference': return node.name as string;
    case 'name': return resolveNameNode(node, useMap);
    case 'nullable': {
      const inner = resolveTypeNode(node.type, useMap);
      return inner ? `?${inner}` : null;
    }
    case 'uniontype':
      return (node.types ?? []).map((t: any) => resolveTypeNode(t, useMap)).filter(Boolean).join('|');
    case 'intersectiontype':
      return (node.types ?? []).map((t: any) => resolveTypeNode(t, useMap)).filter(Boolean).join('&');
    default: return null;
  }
}

/**
 * Builds a ClassSignature from an inline closure or arrow function AST node,
 * so features work without spawning a PHP subprocess.
 */
function resolveClosureSignature(
  node: any,
  source: string,
  useMap: Map<string, string>
): ClassSignature | null {
  if (node.kind !== 'arrowfunc' && node.kind !== 'closure') return null;

  const params: ParamInfo[] = (node.arguments ?? []).map((p: any, i: number) => {
    const name: string = typeof p.name === 'string' ? p.name : (p.name?.name ?? '');

    const isNullable = !!p.nullable || p.type?.kind === 'nullable';
    const typeNode = p.type?.kind === 'nullable' ? p.type.type : p.type;
    const typeStr = resolveTypeNode(typeNode, useMap);

    const hasDefault = p.value !== null && p.value !== undefined;
    const defaultStr = hasDefault && p.value?.loc
      ? source.slice(p.value.loc.start.offset, p.value.loc.end.offset)
      : null;

    const attributes: AttrInfo[] = (p.attrGroups ?? []).flatMap((group: any) =>
      (group.attrs ?? []).map((attr: any) => resolveAttrInfo(attr, useMap, source))
    ).filter((a: AttrInfo | null): a is AttrInfo => a !== null);

    return {
      name,
      type: typeStr,
      nullable: isNullable,
      hasDefault,
      default: defaultStr,
      position: i,
      variadic: !!p.variadic,
      attributes,
    } satisfies ParamInfo;
  });

  const isNullableReturn = !!node.nullable || node.type?.kind === 'nullable';
  const returnTypeNode = node.type?.kind === 'nullable' ? node.type.type : node.type;
  const baseReturn = resolveTypeNode(returnTypeNode, useMap);
  const returnType = isNullableReturn && baseReturn ? `?${baseReturn}` : baseReturn;

  return { ok: true, class: '<closure>', method: '', params, returnType };
}

/** Resolves a `name` AST node to a FQCN using the use-map. */
function resolveNameNode(nameNode: any, useMap: Map<string, string>): string | null {
  if (!nameNode || nameNode.kind !== 'name') return null;
  const raw: string = nameNode.name;
  // Fully qualified (starts with \) — return as-is without leading backslash
  if (nameNode.resolution === 'fqn') return raw.startsWith('\\') ? raw.slice(1) : raw;
  // Explicit `use` import takes priority
  if (useMap.has(raw)) return useMap.get(raw)!;
  // No import — qualify with the file's namespace if present
  const ns = useMap.get('__namespace__');
  return ns ? `${ns}\\${raw}` : raw;
}

import { Diagnostic, DiagnosticSeverity, Range, TextDocument } from 'vscode-languageserver';
import { TextDocument as TD } from 'vscode-languageserver-textdocument';
import { AttrInfo, ClassSignature, ParamInfo, reflectClass, ReflectResult } from './reflector';
import { JobCall, ParsedDocument } from './parser';
import { validateAttribute } from './validator';
import { lintWorkflowSource } from './linter';

type JobEntry = { name: string; call: JobCall } | undefined;

export interface DiagnosticsConfig {
  phpExecutable: string;
  autoloaderPath: string;
}

const CHEVERE_ATTR_NAMESPACE = 'Chevere\\Parameter\\Attributes\\';

export async function computeDiagnostics(
  document: TD,
  parsed: ParsedDocument,
  config: DiagnosticsConfig
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const source = document.getText();

  for (const wCall of parsed.workflowCalls) {
    // Collect all defined job names for response() validation
    const definedJobs = new Set(wCall.jobs.map((j) => j.name));

    // Build jobName -> { type, keys? } map for response() type checking
    // keys is populated from acceptReturn() keys (Chevere Action) or public properties (plain class)
    const jobReturnTypes = new Map<string, { type: string; keys?: Record<string, string | null> }>();
    for (const { name: jobName, call } of wCall.jobs) {
      const sig = call.closureSignature ?? await reflectClass(
        config.phpExecutable,
        config.autoloaderPath,
        call.className,
        call.methodName
      );
      if (sig.ok && (sig as ClassSignature).returnType) {
        const classSig = sig as ClassSignature;
        jobReturnTypes.set(jobName, {
          type: classSig.returnType!,
          keys: classSig.returnKeys ?? classSig.returnClassProperties ?? undefined,
        });
      }
    }

    // For class-based workflows: use the library's lint() to get violations
    // (attribute constraints, type mismatches) without throwing on bad literal values.
    const lintViolationsByJob = new Map<string, Set<string>>();
    if (wCall.enclosingClass && config.autoloaderPath) {
      const lintResult = await lintWorkflowSource(config.phpExecutable, config.autoloaderPath, wCall.enclosingClass, source);
      if (lintResult.ok) {
        for (const violation of lintResult.violations) {
          const jobEntry = wCall.jobs.find((j) => j.name === violation.job);

          // ── parameter violation (arg constraint) ───────────────────────────
          if (violation.parameter) {
            if (!jobEntry) continue;
            const arg = jobEntry.call.args.find((a) => a.name === violation.parameter);
            if (!arg) continue;
            const pos = document.positionAt(arg.valueOffset);
            const endPos = document.positionAt(arg.valueOffset + arg.value.length);
            diagnostics.push({
              range: Range.create(pos, endPos),
              severity: DiagnosticSeverity.Error,
              message: violation.message.trim(),
              source: 'chevere-workflow',
              code: 'lint-violation',
            });
            if (!lintViolationsByJob.has(violation.job)) lintViolationsByJob.set(violation.job, new Set());
            lintViolationsByJob.get(violation.job)!.add(violation.parameter);
            continue;
          }

          // ── withRunIf / withRunIfNot variable violation ────────────────────
          if (violation.method && violation.variable) {
            const chainArg = jobEntry?.call.chainMethodArgs?.find(
              (a) => a.method === violation.method && a.variableName === violation.variable
            );
            const range = chainArg
              ? Range.create(document.positionAt(chainArg.valueOffset), document.positionAt(chainArg.valueOffset + chainArg.value.length))
              : fallbackJobRange(document, jobEntry);
            if (!range) continue;
            diagnostics.push({
              range,
              severity: DiagnosticSeverity.Error,
              message: violation.message.trim(),
              source: 'chevere-workflow',
              code: 'lint-violation',
            });
            continue;
          }

          // ── withRunIf / withRunIfNot response violation ────────────────────
          if (violation.method && violation.response) {
            // violation.response is like "ja->key" or "j0"
            const [respJob, respKey] = violation.response.split('->');
            const chainArg = jobEntry?.call.chainMethodArgs?.find((a) => {
              if (a.method !== violation.method) return false;
              if (!a.responseJobRef) return false;
              if (a.responseJobRef.jobName !== respJob) return false;
              if (respKey !== undefined && a.responseJobRef.key !== respKey) return false;
              return true;
            });
            const range = chainArg
              ? Range.create(document.positionAt(chainArg.valueOffset), document.positionAt(chainArg.valueOffset + chainArg.value.length))
              : fallbackJobRange(document, jobEntry);
            if (!range) continue;
            diagnostics.push({
              range,
              severity: DiagnosticSeverity.Error,
              message: violation.message.trim(),
              source: 'chevere-workflow',
              code: 'lint-violation',
            });
            continue;
          }

          // ── withDepends missing-dependency violation ───────────────────────
          if (violation.method === 'withDepends' && violation.missing?.length) {
            for (const missingJob of violation.missing) {
              const chainArg = jobEntry?.call.chainMethodArgs?.find(
                (a) => a.method === 'withDepends' && a.stringValue === missingJob
              );
              const range = chainArg
                ? Range.create(document.positionAt(chainArg.valueOffset), document.positionAt(chainArg.valueOffset + chainArg.value.length))
                : fallbackJobRange(document, jobEntry);
              if (!range) continue;
              diagnostics.push({
                range,
                severity: DiagnosticSeverity.Error,
                message: violation.message.trim(),
                source: 'chevere-workflow',
                code: 'lint-violation',
              });
            }
            continue;
          }

          // ── job-level violation ────────────────────────────────────────────
          {
            const range = fallbackJobRange(document, jobEntry);
            if (!range) continue;
            diagnostics.push({
              range,
              severity: DiagnosticSeverity.Error,
              message: violation.message.trim(),
              source: 'chevere-workflow',
              code: 'lint-violation',
            });
          }
        }
      }
    }

    for (const { call } of wCall.jobs) {
      const sig = call.closureSignature ?? await reflectClass(
        config.phpExecutable,
        config.autoloaderPath,
        call.className,
        call.methodName
      );

      if (!sig.ok) {
        // Can't resolve class — don't spam errors, might be a fresh file
        continue;
      }

      const classSig = sig as ClassSignature;
      diagnostics.push(...validateJobArgs(document, call, classSig, jobReturnTypes));
      // Skip attr constraint validation for args already reported by lint (avoid duplicates)
      const lintCovered = lintViolationsByJob.get(call.jobName ?? '') ?? new Set<string>();
      diagnostics.push(...await validateAttrConstraints(document, call, classSig, config, lintCovered));
    }

    // Validate response('jobName', 'key') — unknown key in job's return
    for (const { call } of wCall.jobs) {
      for (const arg of call.args) {
        if (!arg.responseJobRef?.key) continue;
        const { jobName, key } = arg.responseJobRef;
        const jobReturn = jobReturnTypes.get(jobName);
        if (!jobReturn?.keys) continue; // no key info available (non-Action or reflection failed)
        if (!(key in jobReturn.keys)) {
          const pos = document.positionAt(arg.valueOffset);
          const endPos = document.positionAt(arg.valueOffset + arg.value.length);
          diagnostics.push({
            range: Range.create(pos, endPos),
            severity: DiagnosticSeverity.Error,
            message: `Key '${key}' does not exist in the return of job '${jobName}'. Available: ${Object.keys(jobReturn.keys).join(', ')}`,
            source: 'chevere-workflow',
            code: 'unknown-response-key',
          });
        }
      }
    }

    // Validate response() references
    for (const ref of parsed.responseRefs) {
      // Check if referenced job exists in this workflow
      // (basic check — offset-based scoping would be more precise)
      if (!definedJobs.has(ref.jobName)) {
        const pos = document.positionAt(ref.offset);
        const endPos = document.positionAt(ref.offset + `response('${ref.jobName}')`.length);
        diagnostics.push({
          range: Range.create(pos, endPos),
          severity: DiagnosticSeverity.Warning,
          message: `Job '${ref.jobName}' is not defined in the enclosing workflow()`,
          source: 'chevere-workflow',
          code: 'undefined-job-reference',
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Checks whether a statically-resolved PHP type is compatible with the
 * expected parameter type from reflection. Only handles primitive types and
 * class names — complex union/intersection types are skipped (returns true).
 */
function isTypeCompatible(actual: string, expected: string, nullable: boolean): boolean {
  if (expected === 'mixed') return true;
  if (nullable && actual === 'null') return true;
  // Union/intersection types from reflection — skip, too complex to validate statically
  if (expected.includes('|') || expected.includes('&')) return true;
  return actual === expected;
}

function validateJobArgs(
  document: TD,
  call: JobCall,
  sig: ClassSignature,
  jobReturnTypes: Map<string, { type: string; keys?: Record<string, string | null> }> = new Map()
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const requiredParams = sig.params.filter((p) => !p.hasDefault && !p.variadic);
  const allParamNames = new Set(sig.params.map((p) => p.name));
  const positionalCount = call.args.filter((a) => a.positional).length;
  const passedNames = new Set(call.args.filter((a) => !a.positional).map((a) => a.name));

  // 1. Missing required arguments
  for (const param of requiredParams) {
    if (param.position < positionalCount) continue; // covered positionally
    if (!passedNames.has(param.name)) {
      const pos = document.positionAt(call.callStart);
      const endPos = document.positionAt(call.callEnd + 1);
      diagnostics.push({
        range: Range.create(pos, endPos),
        severity: DiagnosticSeverity.Error,
        message:
          `Missing required argument '$${param.name}'` +
          (param.type ? ` (${param.type})` : '') +
          ` for ${call.className}`,
        source: 'chevere-workflow',
        code: 'missing-required-arg',
      });
    }
  }

  // 2. Unknown arguments (not in the callable's signature)
  const hasVariadic = sig.params.some((p) => p.variadic);
  for (const arg of call.args) {
    if (arg.positional) continue; // positional args can't be validated by name
    if (hasVariadic) continue; // variadic accepts any named args
    if (!allParamNames.has(arg.name)) {
      const pos = document.positionAt(arg.nameOffset);
      const endPos = document.positionAt(arg.nameOffset + arg.name.length);
      diagnostics.push({
        range: Range.create(pos, endPos),
        severity: DiagnosticSeverity.Error,
        message:
          `Unknown argument '${arg.name}' — ${call.className} does not have this parameter.\n` +
          `Available: ${sig.params.map((p) => p.name).join(', ')}`,
        source: 'chevere-workflow',
        code: 'unknown-arg',
      });
    }
  }

  // 3. Type mismatch for statically-known argument values
  for (const arg of call.args) {
    const param = arg.positional
      ? sig.params[call.args.filter((a) => a.positional).indexOf(arg)]
      : sig.params.find((p) => p.name === arg.name);
    if (!param || !param.type || param.type === 'mixed') continue;

    // 3a. Literal value with a known type
    if (arg.resolvedType !== null) {
      if (!isTypeCompatible(arg.resolvedType, param.type, param.nullable)) {
        const pos = document.positionAt(arg.valueOffset);
        const endPos = document.positionAt(arg.valueOffset + arg.value.length);
        diagnostics.push({
          range: Range.create(pos, endPos),
          severity: DiagnosticSeverity.Error,
          message: `Type mismatch: argument is \`${arg.resolvedType}\` but \`$${param.name}\` expects \`${param.type}\``,
          source: 'chevere-workflow',
          code: 'type-mismatch',
        });
      }
      continue;
    }

    // 3b. response('jobName') or response('jobName', 'key') — compare the referenced job's return type
    if (arg.responseJobRef) {
      const { jobName, key } = arg.responseJobRef;
      const jobReturn = jobReturnTypes.get(jobName);
      // When a key is specified, resolve via acceptReturn() keys; otherwise use the top-level type
      const resolvedType = key
        ? (jobReturn?.keys?.[key] ?? null)
        : (jobReturn?.type ?? null);
      if (resolvedType && !isTypeCompatible(resolvedType, param.type, param.nullable)) {
        const pos = document.positionAt(arg.valueOffset);
        const endPos = document.positionAt(arg.valueOffset + arg.value.length);
        const refLabel = key ? `${jobName}, ${key}` : jobName;
        diagnostics.push({
          range: Range.create(pos, endPos),
          severity: DiagnosticSeverity.Error,
          message: `Type mismatch: \`response(${refLabel})\` is of type \`${resolvedType}\` but \`$${param.name}\` expects \`${param.type}\``,
          source: 'chevere-workflow',
          code: 'type-mismatch',
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Returns a Range pointing to the job's call declaration, used as a fallback
 * when a lint violation cannot be pinned to a specific argument.
 */
function fallbackJobRange(document: TD, jobEntry: JobEntry): Range | null {
  if (!jobEntry) return null;
  const { callStart, callEnd } = jobEntry.call;
  return Range.create(document.positionAt(callStart), document.positionAt(callEnd + 1));
}

/**
 * Validates literal argument values against chevere/parameter attribute
 * constraints (e.g. #[_string('/regex/')], #[_int(min: 2)]) by invoking
 * the attribute class through a PHP subprocess.
 */
async function validateAttrConstraints(
  document: TD,
  call: JobCall,
  sig: ClassSignature,
  config: DiagnosticsConfig,
  lintCovered: Set<string> = new Set()
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  // For closure jobs, build the context needed for reflection-based validation
  const filePath = document.uri.startsWith('file:///')
    ? decodeURIComponent(document.uri.slice('file://'.length))
    : undefined;
  const isClosure = call.className === '<closure>';

  for (const arg of call.args) {
    if (arg.resolvedValue === undefined) continue; // runtime value, skip

    const param = arg.positional
      ? sig.params[call.args.filter((a) => a.positional).indexOf(arg)]
      : sig.params.find((p) => p.name === arg.name);
    if (!param) continue;

    // Skip if this parameter's violation was already reported by lint
    if (lintCovered.has(param.name)) continue;

    // Only validate when the base type already matches (type errors are caught separately)
    if (param.type && arg.resolvedType && arg.resolvedType !== param.type) continue;

    const chevereAttrs = param.attributes.filter(
      (a) => a.class.startsWith(CHEVERE_ATTR_NAMESPACE)
    );

    for (const attr of chevereAttrs) {
      const closureContext = (isClosure && filePath && call.jobName)
        ? { filePath, jobName: call.jobName, paramName: param.name, enclosingClass: call.enclosingClass }
        : undefined;
      const result = await validateAttribute(
        config.phpExecutable,
        config.autoloaderPath,
        attr.class,
        attr.args,
        arg.resolvedValue,
        closureContext
      );
      if (!result.ok && result.error) {
        const pos = document.positionAt(arg.valueOffset);
        const endPos = document.positionAt(arg.valueOffset + arg.value.length);
        diagnostics.push({
          range: Range.create(pos, endPos),
          severity: DiagnosticSeverity.Error,
          message: result.error,
          source: 'chevere-workflow',
          code: 'attr-constraint-violation',
        });
      }
    }
  }

  return diagnostics;
}

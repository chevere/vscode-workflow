import { Hover, MarkupContent, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ClassSignature, reflectClass } from './reflector';
import { JobCall, ParsedDocument } from './parser';
import { lintWorkflow, VariableSchema } from './linter';

export interface HoverConfig {
  phpExecutable: string;
  autoloaderPath: string;
}

export async function computeHover(
  document: TextDocument,
  position: Position,
  parsed: ParsedDocument,
  config: HoverConfig
): Promise<Hover | null> {
  const offset = document.offsetAt(position);

  // Check if hovering over a sync/async call class name or argument
  for (const wCall of parsed.workflowCalls) {
    for (const { call } of wCall.jobs) {
      if (offset < call.callStart || offset > call.callEnd) continue;

      const sig = call.closureSignature ?? await reflectClass(
        config.phpExecutable,
        config.autoloaderPath,
        call.className,
        call.methodName
      );

      if (!sig.ok) {
        return {
          contents: {
            kind: 'markdown',
            value: `**Could not reflect** \`${call.className}\`\n\n\`\`\`\n${sig.error}\n\`\`\``,
          },
        };
      }

      const classSig = sig as ClassSignature;

      // Check if hovering over a variable() arg value inside this call
      for (const ref of parsed.variableRefs) {
        if (offset >= ref.offset && offset <= ref.offset + ref.length) {
          const variableHover = await buildVariableHoverFromLint(ref.name, parsed.workflowClassName, config);
          if (variableHover) return { contents: variableHover };
        }
      }

      // Check if hovering over a specific argument name
      for (const arg of call.args) {
        if (offset >= arg.nameOffset && offset <= arg.nameOffset + arg.name.length + 10) {
          const param = classSig.params.find((p) => p.name === arg.name);
          if (param) {
            return {
              contents: buildParamHover(param, call.className),
            };
          }
        }
      }

      // Hovering over the job call itself — show full signature
      return {
        contents: buildSignatureHover(classSig, call),
      };
    }
  }

  // Check if hovering over response('jobName')
  for (const ref of parsed.responseRefs) {
    const refText = `response('${ref.jobName}')`;
    if (offset >= ref.offset && offset <= ref.offset + refText.length) {
      // Find job in any workflow call
      for (const wCall of parsed.workflowCalls) {
        const job = wCall.jobs.find((j) => j.name === ref.jobName);
        if (!job) continue;

        const sig = job.call.closureSignature ?? await reflectClass(
          config.phpExecutable,
          config.autoloaderPath,
          job.call.className,
          job.call.methodName
        );
        if (!sig.ok) continue;

        const classSig = sig as ClassSignature;
        return {
          contents: {
            kind: 'markdown',
            value:
              `**response(\`'${ref.jobName}'\`)** chains the output of job **${ref.jobName}**\n\n` +
              `- Callable: \`${job.call.className}\`\n` +
              `- Returns: \`${classSig.returnType ?? 'mixed'}\``,
          },
        };
      }
    }
  }

  // Check if hovering over a standalone variable('name') outside a job call
  if (config.autoloaderPath) {
    for (const ref of parsed.variableRefs) {
      if (offset >= ref.offset && offset <= ref.offset + ref.length) {
        const variableHover = await buildVariableHoverFromLint(ref.name, parsed.workflowClassName, config);
        if (variableHover) return { contents: variableHover };
      }
    }
  }

  return null;
}

function buildSignatureHover(sig: ClassSignature, call: JobCall): MarkupContent {
  const params = sig.params
    .map((p) => {
      const typeStr = p.type ? `${p.nullable && !p.type.startsWith('?') && p.type !== 'mixed' ? '?' : ''}${p.type} ` : '';
      const variadicStr = p.variadic ? '...' : '';
      const defaultStr = p.hasDefault ? ` = ${p.default}` : '';
      const attrsStr = p.attributes.length > 0 ? p.attributes.map((a) => `  ${a.display}`).join('\n') + '\n' : '';
      return `${attrsStr}  ${typeStr}${variadicStr}$${p.name}${defaultStr}`;
    })
    .join(',\n');

  const returnStr = sig.returnType ? `: ${sig.returnType}` : '';

  const positionalCount = call.args.filter((a) => a.positional).length;
  const passedNames = new Set(call.args.filter((a) => !a.positional).map((a) => a.name));
  const missingArgs = sig.params
    .filter((p) => !p.hasDefault && !p.variadic && p.position >= positionalCount && !passedNames.has(p.name))
    .map((p) => `⚠️ missing: **$${p.name}**`)
    .join('\n');

  const isClosure = sig.class === '<closure>';
  const header = isClosure ? '### (closure)' : `### ${sig.class}`;
  const funcSig = isClosure
    ? `\`\`\`php\n<?php\nfunction(\n${params}\n)${returnStr}\n\`\`\``
    : `\`\`\`php\n<?php\npublic function ${sig.method}(\n${params}\n)${returnStr}\n\`\`\``;

  return {
    kind: 'markdown',
    value: `${header}\n\n${funcSig}` + (missingArgs ? `\n\n${missingArgs}` : ''),
  };
}

function buildParamHover(
  param: { name: string; type: string | null; nullable: boolean; hasDefault: boolean; default: string | null },
  className: string
): MarkupContent {
  const typeStr = param.type ?? 'mixed';
  return {
    kind: 'markdown',
    value:
      `**Parameter** \`$${param.name}\` of \`${className}\`\n\n` +
      `- Type: \`${typeStr}\`\n` +
      (param.hasDefault ? `- Default: \`${param.default}\`` : '- Required'),
  };
}

async function buildVariableHoverFromLint(
  name: string,
  workflowClassName: string | undefined,
  config: HoverConfig
): Promise<MarkupContent | null> {
  if (!config.autoloaderPath) return null;
  if (!workflowClassName) return null;

  const lintResult = await lintWorkflow(config.phpExecutable, config.autoloaderPath, workflowClassName);
  if (!lintResult.ok || !lintResult.variables) return null;

  const schema = lintResult.variables[name];
  if (!schema) return null;

  return buildVariableHover(name, schema);
}

function buildVariableHover(name: string, schema: VariableSchema): MarkupContent {
  const lines: string[] = [`\`\`\`php\nvariable('${name}')\n\`\`\``];

  for (const [key, value] of Object.entries(schema)) {
    if (value === null || value === undefined) continue;
    if (key === 'required') continue;
    if (key === 'description' && value === '') continue;
    if (key === 'default' && schema.type === 'array' && JSON.stringify(value) === '[]') continue;
    if ((key === 'accept' || key === 'reject') && Array.isArray(value) && value.length === 0 && (schema.type === 'int' || schema.type === 'float')) continue;

    if (key === 'type') {
      lines.push(`- ${key}: \`${value}\``);
      continue;
    }

    // Regex fields: strip surrounding quotes
    if ((key === 'regex' || key === 'pattern') && typeof value === 'string') {
      const pattern = value.replace(/^['"]|['"]$/g, '');
      lines.push(`- ${key}: \`${pattern}\``);
      continue;
    }

    lines.push(`- ${key}: \`${JSON.stringify(value)}\``);
  }

  return {
    kind: 'markdown',
    value: lines.join('\n'),
  };
}

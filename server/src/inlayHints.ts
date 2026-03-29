import { InlayHint, InlayHintKind, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ClassSignature, reflectClass } from './reflector';
import { ParsedDocument } from './parser';

export interface InlayHintsConfig {
  phpExecutable: string;
  autoloaderPath: string;
  showParameterTypes: boolean;
  showResponseTypes: boolean;
}

export async function computeInlayHints(
  document: TextDocument,
  parsed: ParsedDocument,
  range: Range,
  config: InlayHintsConfig
): Promise<InlayHint[]> {
  const hints: InlayHint[] = [];

  for (const wCall of parsed.workflowCalls) {
    // Build a map of jobName -> returnType for response() chaining hints
    const jobReturnTypes = new Map<string, string>();

    for (const { name: jobName, call } of wCall.jobs) {
      const sig = call.closureSignature ?? await reflectClass(
        config.phpExecutable,
        config.autoloaderPath,
        call.className,
        call.methodName
      );
      if (!sig.ok) continue;
      const classSig = sig as ClassSignature;

      if (classSig.returnType) {
        jobReturnTypes.set(jobName, classSig.returnType);
      }

      // --- Parameter inlay hints ---
      // For each passed arg, show: «type» after the colon
      if (config.showParameterTypes) {
        for (const arg of call.args) {
          const param = classSig.params.find((p) => p.name === arg.name);
          if (!param || !param.type) continue;

          const hintPos = document.positionAt(arg.valueOffset);

          // Show type hint as a prefix label before the value
          const typeLabel = param.nullable && !param.type.startsWith('?') ? `?${param.type}` : param.type;
          hints.push({
            position: hintPos,
            label: typeLabel,
            kind: InlayHintKind.Type,
            paddingRight: true,
            tooltip: {
              kind: 'markdown',
              value:
                `**Parameter** \`$${param.name}\` of \`${call.className}\`\n\n` +
                `- Type: \`${typeLabel}\`\n` +
                (param.hasDefault ? `- Default: \`${param.default}\`` : '- Required'),
            },
          });
        }
      }
    }

    // --- Response() inlay hints ---
    // For each response('jobName'), show the return type
    if (config.showResponseTypes) {
      for (const ref of parsed.responseRefs) {
        const returnType = jobReturnTypes.get(ref.jobName);
        if (!returnType) continue;

        const refText = `response('${ref.jobName}')`;
        const endOffset = ref.offset + refText.length;
        const hintPos = document.positionAt(endOffset);

        hints.push({
          position: hintPos,
          label: `: ${returnType}`,
          kind: InlayHintKind.Type,
          paddingLeft: false,
          tooltip: {
            kind: 'markdown',
            value: `Return type of job **${ref.jobName}**`,
          },
        });
      }
    }
  }

  return hints;
}

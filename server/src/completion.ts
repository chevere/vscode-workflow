import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ClassSignature, reflectClass } from './reflector';
import { ParsedDocument } from './parser';

export interface CompletionConfig {
  phpExecutable: string;
  autoloaderPath: string;
}

export async function computeCompletions(
  document: TextDocument,
  position: Position,
  parsed: ParsedDocument,
  config: CompletionConfig
): Promise<CompletionItem[]> {
  const offset = document.offsetAt(position);
  const items: CompletionItem[] = [];

  for (const wCall of parsed.workflowCalls) {
    for (const { name: jobName, call } of wCall.jobs) {
      if (offset < call.callStart || offset > call.callEnd + 5) continue;

      const sig = call.closureSignature ?? await reflectClass(
        config.phpExecutable,
        config.autoloaderPath,
        call.className,
        call.methodName
      );
      if (!sig.ok) continue;

      const classSig = sig as ClassSignature;
      const alreadyPassed = new Set(call.args.map((a) => a.name));

      for (const param of classSig.params) {
        if (alreadyPassed.has(param.name)) continue;

        const typeStr = param.type ?? 'mixed';
        const isRequired = !param.hasDefault;

        items.push({
          label: param.name + ':',
          kind: CompletionItemKind.Field,
          detail: `${typeStr}${param.nullable ? '|null' : ''}${isRequired ? ' (required)' : ' (optional)'}`,
          documentation: {
            kind: 'markdown',
            value:
              `Parameter **\`$${param.name}\`** of \`${call.className}\`\n\n` +
              `- Type: \`${typeStr}\`\n` +
              (param.hasDefault ? `- Default: \`${param.default}\`` : '- **Required**'),
          },
          insertText: `${param.name}: $0`,
          insertTextFormat: InsertTextFormat.Snippet,
          sortText: isRequired ? `0_${param.name}` : `1_${param.name}`,
          filterText: param.name,
        });
      }

      // Also offer response() completions with known job names
      const definedJobNames = wCall.jobs
        .filter((j) => j.name !== jobName)
        .map((j) => j.name);

      for (const jName of definedJobNames) {
        items.push({
          label: `response('${jName}')`,
          kind: CompletionItemKind.Reference,
          detail: `Chain output of job '${jName}'`,
          insertText: `response('${jName}')`,
          sortText: `2_${jName}`,
        });
      }
    }
  }

  return items;
}

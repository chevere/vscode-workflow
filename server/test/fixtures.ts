import { ClassSignature, ParamInfo } from '../src/reflector';

// ─── Param builders ───────────────────────────────────────────────────────────

function param(
  name: string,
  type: string | null,
  opts: Partial<ParamInfo> = {}
): ParamInfo {
  return {
    name,
    type,
    nullable: false,
    hasDefault: false,
    default: null,
    position: 0,
    variadic: false,
    attributes: [],
    ...opts,
  };
}

// ─── ClassSignature fixtures ──────────────────────────────────────────────────

export const sigOneStringParam: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('name', 'string', { position: 0 }),
  ],
  returnType: 'void',
};

export const sigTwoParams: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('name', 'string', { position: 0 }),
    param('count', 'int', { position: 1, hasDefault: true, default: '0' }),
  ],
  returnType: 'void',
};

export const sigMixedParams: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('required', 'string', { position: 0 }),
    param('optional', 'int', { position: 1, hasDefault: true, default: '42' }),
  ],
  returnType: 'void',
};

export const sigNullableParam: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('value', 'string', { position: 0, nullable: true }),
  ],
  returnType: 'void',
};

export const sigMixedTypeParam: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('anything', 'mixed', { position: 0 }),
  ],
  returnType: 'void',
};

export const sigWithReturnType: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('name', 'string', { position: 0 }),
  ],
  returnType: 'string',
};

export const sigWithReturnKeys: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('name', 'string', { position: 0 }),
  ],
  returnType: 'mixed',
  returnKeys: { name: 'string', age: 'int' },
};

export const sigWithAttr: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('email', 'string', {
      position: 0,
      attributes: [
        {
          class: 'Chevere\\Parameter\\Attributes\\_string',
          shortName: '_string',
          args: { 0: '/^[a-z]+$/' },
          display: "#[_string('/^[a-z]+$/')]",
        },
      ],
    }),
  ],
  returnType: 'void',
};

export const sigVariadicParam: ClassSignature = {
  ok: true,
  class: 'App\\Jobs\\MyJob',
  method: '__invoke',
  params: [
    param('name', 'string', { position: 0 }),
    param('tags', 'string', { position: 1, variadic: true }),
  ],
  returnType: 'void',
};

// ─── PHP source string factories ─────────────────────────────────────────────

export function phpWorkflow(jobs: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n\n$w = workflow(\n${jobs}\n);\n`;
}

export function phpWorkflowWithUse(useStmts: string, jobs: string): string {
  return `<?php\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\nuse function Chevere\\Workflow\\async;\n${useStmts}\n\n$w = workflow(\n${jobs}\n);\n`;
}

export function phpWorkflowInClass(namespace: string, className: string, jobs: string): string {
  return `<?php\nnamespace ${namespace};\nuse function Chevere\\Workflow\\workflow;\nuse function Chevere\\Workflow\\sync;\n\nclass ${className} {\n  public static function workflow() {\n    return workflow(\n${jobs}\n    );\n  }\n}\n`;
}

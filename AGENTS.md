# Development Guidelines

## Project Overview

`chevere/vscode-workflow` is a VS Code extension providing LSP support for the [chevere/workflow](https://github.com/chevere/workflow) PHP library: diagnostics, autocompletion, hover documentation, inlay hints, and an interactive job graph visualization for PHP workflow definitions.

Analysis combines static AST parsing (`php-parser`) with dynamic PHP subprocess reflection to validate job arguments, type compatibility, and parameter attribute constraints.

## Repository Structure

TypeScript monorepo with two npm workspaces. Builds managed by `esbuild.js`.

```plain
chevere/vscode-workflow/
├── package.json              # Root: extension manifest + workspace config
├── tsconfig.json             # Root composite TypeScript config
├── esbuild.js                # Custom build script (bundles client + server, copies vendor assets)
├── client/
│   ├── src/extension.ts      # Activation, commands, CodeLens provider
│   ├── src/gotoSource.ts     # WebView gotoSource message validation
│   ├── src/openExternal.ts   # WebView openExternal message validation (https: only)
│   └── test/                 # gotoSource + openExternal security tests; extension activation tests
└── server/
    └── src/
        ├── server.ts          # LSP connection, capabilities, handler registration
        ├── parser.ts          # PHP AST parsing — extracts workflow() calls, resolves FQCNs
        ├── reflector.ts       # PHP reflection via subprocess + in-memory cache
        ├── reflectScript.ts   # Embedded PHP reflection helper (string const → temp file)
        ├── diagnostics.ts     # Validation: args, types, response() chains, attributes
        ├── validateScript.ts  # Embedded PHP attribute validation helper
        ├── validator.ts       # Attribute constraint validation executor
        ├── linter.ts          # Workflow lint runner: spawns lint.php, caches LintResult
        ├── lintScript.ts      # Embedded PHP lint helper
        ├── hover.ts           # Hover documentation provider
        ├── completion.ts      # Autocomplete suggestions
        ├── inlayHints.ts      # Inline type hints
        ├── jobGraph.ts        # Mermaid graph HTML visualization
        ├── phpExecutable.ts   # PHP executable validation/sanitization
        └── tempDir.ts         # Per-process private temp dir (CWE-377 safe, mode 0700)
```

**Build outputs:** `client/out/` and `server/out/` (git-ignored). Vendor assets (Mermaid, Codicons) copied to `dist/vendor/`.

## Tech Stack

| Layer           | Technology                                           |
| --------------- | ---------------------------------------------------- |
| Language        | TypeScript 5.3 (strict)                              |
| Runtime         | Node.js LTS                                          |
| LSP             | `vscode-languageserver` / `vscode-languageclient` v9 |
| PHP AST         | `php-parser` v3.1 (Glayzzle)                         |
| PHP reflection  | PHP subprocess (configurable executable)             |
| Graph rendering | Mermaid v11 (local WebView asset)                    |
| Packaging       | `@vscode/vsce`                                       |
| Target VS Code  | `^1.85.0`                                            |
| Build           | `esbuild` (`esbuild.js`)                             |

## Development

### Setup

```bash
npm install          # install all workspace dependencies
npm run compile      # one-shot build
npm run watch        # incremental watch build
npm run package      # produces .vsix
```

### Debugging

Use VS Code **Run and Debug** panel:

- **Launch Extension** — Extension Development Host
- **Attach to Server** — Node.js debugger on port 6009
- **Client + Server** — compound config

### Testing

#### Server (`server/test/`)

| File                       | Module                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `parser.test.ts`           | `parser.ts`                                                    |
| `reflector.test.ts`        | `reflector.ts`                                                 |
| `diagnostics.test.ts`      | `diagnostics.ts`                                               |
| `completion.test.ts`       | `completion.ts`                                                |
| `hover.test.ts`            | `hover.ts`                                                     |
| `inlayHints.test.ts`       | `inlayHints.ts`                                                |
| `jobGraph.test.ts`         | `jobGraph.ts`                                                  |
| `validator.test.ts`        | `validator.ts`                                                 |
| `security.test.ts`         | Security vulnerability demos (do not fix — prove issues exist) |
| `tempFileSecurity.test.ts` | Temp file security (`reflector.ts` / `tempDir.ts`)             |
| `fixtures.ts`              | Shared helpers / fixture builders                              |

```bash
npm run test --workspace=server           # run once
npm run test:watch --workspace=server     # watch mode
npm run test:coverage --workspace=server  # coverage (c8, text + lcov)
```

Coverage excludes `*Script.ts` files (embedded PHP string constants only).

#### Client (`client/test/`, `client/src/test/`)

```bash
npm run test --workspace=client
```

Uses `@vscode/test-cli` for extension host integration and plain Mocha for unit tests.

## LSP Features

| Feature     | Capability                                         | Source                       |
| ----------- | -------------------------------------------------- | ---------------------------- |
| Diagnostics | `textDocumentSync` (incremental)                   | `diagnostics.ts`             |
| Hover       | `hoverProvider: true`                              | `hover.ts`                   |
| Completion  | triggers: `,` `(` ` `                              | `completion.ts`              |
| Inlay Hints | `inlayHintProvider: true`                          | `inlayHints.ts`              |
| Job Graph   | custom request `chevereWorkflow/jobGraph`          | `jobGraph.ts`                |
| Config sync | custom notification `chevereWorkflow/configChange` | `server.ts` ↔ `extension.ts` |

### Commands

| ID                                | Label                    | Description                              |
| --------------------------------- | ------------------------ | ---------------------------------------- |
| `chevereWorkflow.showJobGraph`    | Show Job Graph           | Opens Mermaid visualization              |
| `chevereWorkflow.restartServer`   | Restart Server           | Restarts the LSP server                  |
| `chevereWorkflow.installWorkflow` | Install chevere/workflow | Runs `composer require chevere/workflow` |

### Settings

| Setting                                         | Default | Description                     |
| ----------------------------------------------- | ------- | ------------------------------- |
| `chevereWorkflow.enable`                        | `true`  | Enable/disable the extension    |
| `chevereWorkflow.phpExecutable`                 | `"php"` | PHP executable path             |
| `chevereWorkflow.composerJsonPath`              | `""`    | Override `composer.json` path   |
| `chevereWorkflow.inlayHints.showParameterTypes` | `true`  | Show parameter type hints       |
| `chevereWorkflow.inlayHints.showResponseTypes`  | `true`  | Show response return type hints |

## PHP Integration

### Reflection Flow

1. Parser extracts job FQCN from PHP AST.
2. `reflector.ts` writes `reflectScript.ts` to a temp file (once per process).
3. Spawns: `php /tmp/chevere-XXXXXX/reflect.php <autoloader> <ClassName> [<method>]`
4. Tries method candidates: explicit name → `__invoke` → `run` → `handle` → `execute`.
5. Returns `ClassSignature` JSON: class, method, params (name, type, default, required, attributes).
6. For Chevere Action classes, also extracts `acceptReturn()` keys for `response()` chain typing.

### Attribute Validation Flow

1. `diagnostics.ts` identifies arguments with literal values (strings, integers, booleans).
2. Checks if the parameter has Chevere attribute constraints (`Chevere\Parameter\Attributes\*`).
3. Spawns `validateScript.ts` PHP script with the attribute class, args, and value.
4. PHP `InvalidArgumentException` → diagnostic error.

### Autoloader Discovery

Searches for `vendor/autoload.php` relative to the open workspace. `composerJsonPath` overrides the search root. Without an auto-loader, PHP reflection is skipped (structural argument validation still works).

## Code Conventions

- **camelCase** functions/variables, **PascalCase** interfaces/types, **SCREAMING_SNAKE_CASE** module constants, `_underscore` prefix for private module state
- One cohesive module per file; interfaces at top, helpers at bottom; section separators `// ─ ─ ─`
- `"strict": true`; no implicit `any`; error results use `{ ok: true; data: T } | { ok: false; error: string }`
- `async/await` throughout; `execFile` (not `exec`) for subprocesses; all subprocess calls include explicit timeouts
- The three `*Script.ts` files each export a single PHP string constant written to a temp file at runtime — output must be JSON only

## CI/CD

| Workflow                        | Trigger         | Purpose                |
| ------------------------------- | --------------- | ---------------------- |
| `.github/workflows/test.yml`    | every push / PR | testing                |
| `.github/workflows/publish.yml` | GitHub release  | package + publish VSIX |

## Git

- **Main branch:** `main`
- **Feature branches:** `agent-name/<description>-<id>`
- **Remote:** `origin`
- Prefer descriptive commit messages

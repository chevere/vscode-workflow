# CLAUDE.md — chevere/vscode-workflow

## Project Overview

`chevere/vscode-workflow` is a VS Code extension that provides Language Server Protocol (LSP) support for the [chevere/workflow](https://github.com/chevere/workflow) PHP library. It gives developers diagnostics, autocompletion, hover documentation, inlay hints, and an interactive job graph visualization while writing workflow definitions in PHP.

The extension analyzes PHP code through a combination of static AST parsing and dynamic PHP subprocess reflection to validate job arguments, type compatibility, and parameter attribute constraints.

---

## Repository Structure

This is a TypeScript monorepo with two npm workspaces plus a root-level extension manifest. Builds are managed by a custom `esbuild.js` script (see below).

```plain
chevere/vscode-workflow/
├── package.json              # Root: extension manifest + npm workspace config
├── tsconfig.json             # Root composite TypeScript config
├── README.md                 # User-facing documentation
│
├── client/                   # VS Code extension client
│   ├── src/extension.ts      # Activation, commands, CodeLens provider
│   ├── src/test/extension.test.js # Extension activation/command tests (VS Code API)
│   ├── package.json
│   └── tsconfig.json
│   └── test/
│       ├── gotoSource.test.ts     # Security/validation tests for gotoSource
│       └── openExternal.test.ts   # Security/validation tests for openExternal
│
├── server/                   # LSP server (Node.js)
│   ├── src/
│   │   ├── server.ts         # LSP connection, capabilities, handler registration
│   │   ├── parser.ts         # PHP AST parsing — extracts workflow() calls
│   │   ├── reflector.ts      # PHP reflection via subprocess + in-memory cache
│   │   ├── reflectScript.ts  # Embedded PHP reflection helper script (string const)
│   │   ├── diagnostics.ts    # Validation: args, types, response() chains, attributes
│   │   ├── validateScript.ts # Embedded PHP attribute validation helper (string const)
│   │   ├── linter.ts         # Workflow lint runner: spawns lint.php, caches LintResult
│   │   ├── lintScript.ts     # Embedded PHP lint helper (string const)
│   │   ├── hover.ts          # Hover documentation provider
│   │   ├── completion.ts     # Autocomplete suggestions
│   │   ├── inlayHints.ts     # Inline type hints
│   │   ├── jobGraph.ts       # Workflow graph HTML/Mermaid visualization
│   │   ├── phpExecutable.ts  # PHP executable validation and sanitization
│   │   ├── tempDir.ts        # Per-process private temp directory (CWE-377 safe)
│   │   └── validator.ts      # Attribute constraint validation executor
│   ├── package.json
│   └── tsconfig.json
│
└── .vscode/
    ├── launch.json           # Debug: Extension Host, Attach to Server, combined
    └── tasks.json            # Watch task (npm: watch)
```

**Build system:**

- `esbuild.js` bundles both client and server (see below for details)
- `npm run compile`/`npm run watch` use esbuild for fast incremental builds
- Static assets (Mermaid, Codicons) are copied to `dist/vendor/` for WebView use

**Compiled output** goes into `client/out/` and `server/out/`. These are `.gitignore`d.

---

## Tech Stack & Build

| Layer                     | Technology                                            |
| ------------------------- | ----------------------------------------------------- |
| Language                  | TypeScript 5.3 (strict mode)                          |
| Runtime                   | Node.js (LTS)                                         |
| LSP protocol              | `vscode-languageserver` / `vscode-languageclient` v9  |
| PHP AST                   | `php-parser` v3.1 (Glayzzle)                          |
| PHP reflection/validation | PHP subprocess (configurable executable)              |
| Graph rendering           | Mermaid v11 (local WebView asset from `node_modules`) |
| Extension packaging       | `@vscode/vsce`                                        |
| Target VS Code            | `^1.85.0`                                             |
| Build tool                | `esbuild` (custom script: `esbuild.js`)               |

---

## Development Setup

### Prerequisites

- Node.js LTS
- npm
- VS Code
- PHP (accessible as `php` or configured via `chevereWorkflow.phpExecutable`)
- A PHP project using `chevere/workflow` with `vendor/autoload.php`

### Install & Build

```bash
# Install all workspace dependencies
npm install

# One-shot compile (both client and server)
npm run compile

# Watch mode for incremental builds during development
npm run watch
```

### Build: esbuild.js

The root `esbuild.js` script bundles both the client and server using esbuild. It also copies required static assets (Mermaid, Codicons) to `dist/vendor/` for use in the job graph WebView.

**Entry points and outputs:**

| Entry                     | Output                    | Notes                    |
| ------------------------- | ------------------------- | ------------------------ |
| `client/src/extension.ts` | `client/out/extension.js` | `vscode` marked external |
| `server/src/server.ts`    | `server/out/server.js`    |                          |

**Vendor assets copied to `dist/vendor/`:**

- `mermaid.min.js` — loaded as WebView static asset (not bundled)
- `codicons/codicon.css` + `codicons/codicon.ttf` — required by WebView UI

**Flags:**

- `--watch` — incremental rebuild on change (esbuild context API, both client and server in parallel)
- `--minify` — minified output; sourcemaps are disabled when minifying (sourcemaps on by default)

All builds target `node18`, format `cjs`, platform `node`.

### Running / Debugging

Use VS Code's **Run and Debug** panel with the provided launch configs:

- **Launch Extension** — opens an Extension Development Host with the extension loaded
- **Attach to Server** — attaches Node.js debugger to the running LSP server (port 6009)
- **Client + Server** — launches both at once (compound config)

The watch task (`npm run watch`) must be running for live recompilation.

### Packaging

```bash
# Produces chevere/vscode-workflow-<version>.vsix
npm run package
```

### Testing

#### Server tests

Automated tests use **Mocha** + **ts-mocha** with **sinon** for mocking. Tests live in `server/test/` and cover all major modules:

| File                                   | Module under test                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `server/test/parser.test.ts`           | `parser.ts`                                                                  |
| `server/test/reflector.test.ts`        | `reflector.ts`                                                               |
| `server/test/diagnostics.test.ts`      | `diagnostics.ts`                                                             |
| `server/test/completion.test.ts`       | `completion.ts`                                                              |
| `server/test/hover.test.ts`            | `hover.ts`                                                                   |
| `server/test/inlayHints.test.ts`       | `inlayHints.ts`                                                              |
| `server/test/jobGraph.test.ts`         | `jobGraph.ts`                                                                |
| `server/test/validator.test.ts`        | `validator.ts`                                                               |
| `server/test/security.test.ts`         | Security vulnerability demonstration tests (do not fix — prove issues exist) |
| `server/test/tempFileSecurity.test.ts` | Temp file security tests (`reflector.ts` / `tempDir.ts`)                     |

Run with:

```sh
# Run tests once
npm run test --workspace=server
# Watch mode
npm run test:watch --workspace=server
# Coverage
npm run test:coverage --workspace=server
```

Coverage is collected via **c8** and reported as text + lcov. The `*Script.ts` files are excluded from coverage.

#### Client tests

Client-side tests are in `client/test/` and `client/src/test/`:

- `client/test/gotoSource.test.ts` — Security/validation for gotoSource (workspace/scheme checks)
- `client/test/openExternal.test.ts` — Security/validation for openExternal (scheme allowlist)
- `client/src/test/extension.test.js` — Extension activation and command registration (VS Code API)

Run client tests with:

```sh
# From repo root
npm run test --workspace=client
```

These use [@vscode/test-cli](https://github.com/microsoft/vscode-test-cli) for extension host integration, and plain Mocha for unit tests.

### Parsing Strategy

The server uses **AST-based parsing** via `php-parser` rather than regex. This handles:

- Strings, comments, heredocs correctly
- Nested expressions and method chains
- `use` statement resolution to fully-qualified class names (FQCN)
- Array callables: `[$this, 'method']`, `[Foo::class, 'method']`
- Inline closures/arrow functions as job definitions

---

## Key Files & Responsibilities

| File                           | Responsibility                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `client/src/extension.ts`      | Extension activation, command registration, CodeLens for `workflow()` calls, WebView for job graph        |
| `server/src/server.ts`         | LSP connection setup, capability declaration, document event handlers, request routing                    |
| `server/src/parser.ts`         | Core AST parser — finds `workflow()` / `response()` calls, resolves class names, returns `ParsedDocument` |
| `server/src/reflector.ts`      | PHP reflection wrapper: spawns subprocess, caches `ClassSignature` results                                |
| `server/src/reflectScript.ts`  | PHP script (as TS string) for class/method reflection — outputs JSON                                      |
| `server/src/diagnostics.ts`    | Validates job arguments (missing, unknown, type mismatch), `response()` chains, attribute constraints     |
| `server/src/validateScript.ts` | PHP script (as TS string) for attribute constraint validation                                             |
| `server/src/validator.ts`      | Executes attribute validation subprocess, caches results                                                  |
| `server/src/hover.ts`          | Hover tooltips: shows method signature and parameter details                                              |
| `server/src/completion.ts`     | Autocomplete: parameter names (required first), `response()` job references                               |
| `server/src/inlayHints.ts`     | Inline type hints for parameter types and `response()` return types                                       |
| `server/src/jobGraph.ts`       | Generates interactive Mermaid graph HTML; Mermaid source comes from the lint result                       |
| `server/src/linter.ts`         | Workflow lint runner: spawns `lint.php`, caches `LintResult`, supports in-editor source linting           |
| `server/src/lintScript.ts`     | PHP script (as TS string) calling `ClassName::workflow()->lint()` — outputs violations + Mermaid JSON     |
| `server/src/phpExecutable.ts`  | Validates and sanitizes the configured PHP executable name (rejects absolute paths)                       |
| `server/src/tempDir.ts`        | Lazily creates a per-process private temp dir (`chevere-XXXXXX`, mode `0700`), cleaned on exit            |

---

## Code Conventions

### Naming

- **camelCase** for functions and variables
- **PascalCase** for interfaces and types
- **SCREAMING_SNAKE_CASE** for module-level constants
- Underscore prefix (`_scriptPath`) for private/internal module state

### File Organization

- One cohesive module per file
- Interfaces and types defined at the top of each file
- Helper functions at the bottom
- Section separators use `// ─ ─ ─` style comments

### TypeScript

- `"strict": true` enforced across all `tsconfig.json` files
- `"target": "ES2020"`, `"module": "commonjs"`
- No implicit `any`; all data flows typed through explicit interfaces
- Error results use an `ok: boolean` discriminated union pattern:

  ```typescript
  type Result = { ok: true; data: T } | { ok: false; error: string }
  ```

### Async Patterns

- Promise-based with `async/await` throughout
- `execFile` (not `exec`) for subprocess calls — avoids shell injection
- All subprocess calls include explicit timeouts

### Embedded PHP Scripts

The three `*Script.ts` files (`reflectScript.ts`, `validateScript.ts`, `lintScript.ts`) each export a single string constant containing a PHP script. These are written to temp files at runtime. When modifying them, keep the PHP self-contained and ensure it outputs only JSON (no other stdout).

---

## LSP Features

| Feature     | Capability                                         | Source File                  |
| ----------- | -------------------------------------------------- | ---------------------------- |
| Diagnostics | `textDocumentSync` (incremental)                   | `diagnostics.ts`             |
| Hover       | `hoverProvider: true`                              | `hover.ts`                   |
| Completion  | `completionProvider` (triggers: `,`, `(`, ` `)     | `completion.ts`              |
| Inlay Hints | `inlayHintProvider: true`                          | `inlayHints.ts`              |
| Job Graph   | Custom request `chevereWorkflow/jobGraph`          | `jobGraph.ts`                |
| Config sync | Custom notification `chevereWorkflow/configChange` | `server.ts` ↔ `extension.ts` |

### VS Code Commands

| Command ID                        | Label                    | Description                                               |
| --------------------------------- | ------------------------ | --------------------------------------------------------- |
| `chevereWorkflow.showJobGraph`    | Show Job Graph           | Opens Mermaid visualization of workflow                   |
| `chevereWorkflow.restartServer`   | Restart Server           | Restarts the LSP server process                           |
| `chevereWorkflow.installWorkflow` | Install chevere/workflow | Runs `composer require chevere/workflow` in the workspace |

### Extension Settings

| Setting                                         | Default | Description                           |
| ----------------------------------------------- | ------- | ------------------------------------- |
| `chevereWorkflow.enable`                        | `true`  | Enable/disable the extension          |
| `chevereWorkflow.phpExecutable`                 | `"php"` | Path to PHP executable                |
| `chevereWorkflow.composerJsonPath`              | `""`    | Override path to `composer.json`      |
| `chevereWorkflow.inlayHints.showParameterTypes` | `true`  | Show parameter type inlay hints       |
| `chevereWorkflow.inlayHints.showResponseTypes`  | `true`  | Show response return type inlay hints |

---

## PHP Integration Details

### Reflection Flow

1. Parser extracts a job's class name (FQCN) from the PHP AST.
2. `reflector.ts` writes `reflectScript.ts` content to a temp file if not already present.
3. Spawns: `php /tmp/chevere-XXXXXX/reflect.php <autoloader> <ClassName> [<method>]`
4. Script tries method candidates in order: explicit name → `__invoke` → `run` → `handle` → `execute`.
5. Returns JSON with `ClassSignature`: class, method, params (name, type, default, required, attributes).
6. For Chevere Action classes, also extracts `acceptReturn()` keys for `response()` chain typing.

### Attribute Validation Flow

1. `diagnostics.ts` identifies arguments with literal values (strings, integers, booleans).
2. For each, checks if the corresponding parameter has Chevere attribute constraints (`Chevere\Parameter\Attributes\*`).
3. Spawns `validateScript.ts` PHP script with the attribute class, args, and value.
4. If PHP throws `InvalidArgumentException`, reports it as a diagnostic error.

### Autoloader Discovery

The server searches for `vendor/autoload.php` relative to the open workspace. `composerJsonPath` can override the search root. Without a resolvable autoloader, PHP reflection is skipped (no diagnostics for type/constraint issues, but structural argument validation still works).

---

## Server Tests

The server package has automated tests using **Mocha** + **ts-mocha** with **sinon** for mocking. Tests live in `server/test/` and cover all major modules.

### Test files

| File                                   | Module under test                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `server/test/parser.test.ts`           | `parser.ts`                                                                  |
| `server/test/reflector.test.ts`        | `reflector.ts`                                                               |
| `server/test/diagnostics.test.ts`      | `diagnostics.ts`                                                             |
| `server/test/completion.test.ts`       | `completion.ts`                                                              |
| `server/test/hover.test.ts`            | `hover.ts`                                                                   |
| `server/test/inlayHints.test.ts`       | `inlayHints.ts`                                                              |
| `server/test/jobGraph.test.ts`         | `jobGraph.ts`                                                                |
| `server/test/validator.test.ts`        | `validator.ts`                                                               |
| `server/test/security.test.ts`         | Security vulnerability demonstration tests (do not fix — prove issues exist) |
| `server/test/tempFileSecurity.test.ts` | Temp file security tests (`reflector.ts` / `tempDir.ts`)                     |

### Running tests

```bash
# Run tests once
npm run test --workspace=server

# Run tests in watch mode
npm run test:watch --workspace=server

# Run tests with coverage report
npm run test:coverage --workspace=server
```

Coverage is collected via **c8** and reported as text + lcov. The `*Script.ts` files are excluded from coverage (they contain only embedded PHP string constants).

For manual end-to-end testing:

1. Run `npm run watch` to keep TypeScript compiled.
2. Launch the Extension Development Host via the "Launch Extension" debug config.
3. Open a PHP project that uses `chevere/workflow` with `vendor/autoload.php` present.
4. Write or open PHP files with `workflow()` calls and verify diagnostics, completions, hover, and inlay hints appear correctly.
5. Click "Show Job Graph" code lens to test the visualization.

---

## CI/CD

CI runs on GitHub Actions (`.github/workflows/test.yml`) on every push and pull request to any branch.

### Pipeline steps

1. Checkout code
2. Set up Node.js LTS
3. `npm install`
4. `npm run test:coverage --workspace=server` — runs the full test suite with coverage
5. Upload `server/coverage/lcov.info` as a build artifact (`coverage`)

---

## Git

- **Main branch**: `main`
- **Active development branch**: Feature branches named `claude/<description>-<id>` (e.g., `claude/add-claude-documentation-KIi6I`)
- **Remote**: `origin`
- Commit messages in this repo have been informal; prefer descriptive messages for new work.

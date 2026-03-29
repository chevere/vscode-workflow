# Chevere Workflow

VS Code extension providing complete language server support for [Chevere Workflow](https://chevere.org/packages/workflow) PHP definitions.

## Features

- **Diagnostics**: Validates job arguments against reflected PHP class signatures: missing required params, unknown args, type mismatches, `response()` chain errors, [Chevere Parameter attribute](https://github.com/chevere/parameter) constraint violations, `withRunIf()`/`withRunIfNot()` variable and response violations, and `withDepends()` missing dependency errors
- **Inlay hints**: Shows parameter types before argument values and return types after `response()` calls
- **Hover**: Displays full method signatures with parameter types, defaults, and required/optional status; hovering over `variable('name')` shows the variable's schema
- **Completion**: Suggests available parameter names (required first) with snippet expansion; offers `response()` references to other jobs in the workflow
- **Job graph**: Interactive Mermaid visualization of the workflow dependency graph, with zoom/pan controls, a raw Mermaid syntax tab, and a copy-to-clipboard button

## Requirements

- VS Code `^1.85.0`
- PHP executable accessible from your shell (or configured via settings)
- A project using [chevere/workflow](https://github.com/chevere/workflow) with a `composer.json`

## Extension Settings

| Setting                                         | Default | Description                                      |
| ----------------------------------------------- | ------- | ------------------------------------------------ |
| `chevereWorkflow.enable`                        | `true`  | Enable/disable the extension                     |
| `chevereWorkflow.phpExecutable`                 | `"php"` | Path to the PHP executable                       |
| `chevereWorkflow.composerJsonPath`              | `""`    | Path to `composer.json` (auto-detected if empty) |
| `chevereWorkflow.inlayHints.showParameterTypes` | `true`  | Show parameter type hints                        |
| `chevereWorkflow.inlayHints.showResponseTypes`  | `true`  | Show response return type hints                  |

## Commands

| Command                                      | Description                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Chevere Workflow: Restart Server`           | Restarts the language server                                                                                  |
| `Chevere Workflow: Show Job Graph`           | Opens an interactive visualization of the current workflow                                                    |
| `Chevere Workflow: Install chevere/workflow` | Opens a terminal and runs `composer require chevere/workflow` in the workspace root (trusted workspaces only) |

The **Show Job Graph** command is also available as a CodeLens button that appears above every `workflow()` call in the editor.

## Project Structure

```plain
chevere-workflow-lsp/
├── client/src/extension.ts      # VS Code extension entry point
└── server/src/
    ├── server.ts                # LSP connection and handlers
    ├── parser.ts                # PHP AST parsing (php-parser)
    ├── diagnostics.ts           # Argument validation logic
    ├── reflector.ts             # PHP reflection wrapper
    ├── reflectScript.ts         # Embedded PHP reflection script
    ├── validateScript.ts        # Embedded PHP attribute validation script
    ├── validator.ts             # Attribute constraint validation executor
    ├── inlayHints.ts            # Inline type hints
    ├── hover.ts                 # Hover documentation
    ├── completion.ts            # Autocomplete suggestions
    ├── linter.ts                # PHP linter wrapper (lint violations)
    ├── lintScript.ts            # Embedded PHP linter script
    ├── phpExecutable.ts         # PHP executable sanitization/validation
    ├── tempDir.ts               # Per-process private temp directory
    ├── jobGraph.ts              # Workflow graph (Mermaid)
    └── mermaidScript.ts         # Embedded PHP Mermaid generator script
```

The repo is a npm workspace monorepo. The `client` package is the VS Code extension; the `server` package is the language server connected via Node.js IPC.

## Dev Setup

**Install dependencies:**

```sh
npm install
```

**Compile (one-shot):**

```sh
npm run compile
```

**Compile (watch mode):**

```sh
npm run watch
```

**Run the extension in VS Code:**

Open the repo in VS Code and press `F5` (or run `Debug: Start Debugging`). This launches an Extension Development Host with the extension loaded.

**Package as `.vsix`:**

```sh
npm run package
```

The generated `.vsix` file can be installed manually via `Extensions: Install from VSIX...` in VS Code.

## License

Copyright [Rodolfo Berrios A.](https://rodolfoberrios.com/)

This software is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

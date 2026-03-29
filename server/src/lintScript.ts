/**
 * lint.php is spawned by the LSP server to run the workflow library's built-in
 * IDE lint mode on a class-based workflow. It calls ClassName::workflow()->lint()
 * which returns violations (without throwing) and a Mermaid graph string.
 *
 * Usage: php lint.php <autoloader_path> <ClassName> [<extra_file>]
 *   <extra_file>  Optional path to a temp PHP file to require before checking the class.
 *                 Used for linting unsaved in-editor content.
 *
 * Output JSON shape:
 * { "ok": true, "violations": [{"job": "...", "parameter": "...", "message": "..."}], "mermaid": "..." }
 * { "ok": false, "error": "..." }
 */
export const LINT_PHP_SCRIPT = /* php */ `<?php
declare(strict_types=1);

[$autoloader, $className, $extraFile] = array_slice($argv, 1, 3) + [null, null, null];

if (!file_exists($autoloader)) {
    echo json_encode(['ok' => false, 'error' => "Autoloader not found: $autoloader"]);
    exit(1);
}

require $autoloader;

if ($extraFile !== null) {
    if (!file_exists($extraFile)) {
        echo json_encode(['ok' => false, 'error' => "Extra file not found: $extraFile"]);
        exit(1);
    }
    require $extraFile;
}

if (!class_exists($className)) {
    echo json_encode(['ok' => false, 'error' => "Class not found: $className"]);
    exit(1);
}

if (!method_exists($className, 'workflow')) {
    echo json_encode(['ok' => false, 'error' => "No workflow() method on: $className"]);
    exit(1);
}

try {
    $result = json_decode($className::workflow()->lint(), true);
    echo json_encode(['ok' => true, ...$result]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(1);
}
`;

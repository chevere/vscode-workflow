export const VALIDATE_PHP_SCRIPT = /* php */ `<?php
declare(strict_types=1);

$_args = array_slice($argv, 1);
$autoloader = $_args[0] ?? null;
$attrClass   = $_args[1] ?? null;
$argsJson    = $_args[2] ?? '[]';
$valueJson   = $_args[3] ?? 'null';
$filePath       = $_args[4] ?? null;
$jobName        = $_args[5] ?? null;
$paramName      = $_args[6] ?? null;
$enclosingClass = $_args[7] ?? null;

if (!file_exists($autoloader)) {
    echo json_encode(['ok' => false, 'error' => "Autoloader not found: $autoloader"]);
    exit(1);
}

require $autoloader;

$value = json_decode($valueJson, true, 512, JSON_THROW_ON_ERROR);

if ($filePath !== null && $jobName !== null && $paramName !== null && $enclosingClass === null) {
    // Closure path: load the user's file, get the workflow, reflect the closure's
    // parameter attributes via ReflectionFunction — no eval() involved.
    // Only used for file-based workflows (not class-based, which use the structured path below).
    try {
        if (!file_exists($filePath)) {
            echo json_encode(['ok' => true]);
            exit(0);
        }
        $workflow = (function() use ($autoloader, $filePath) {
            return require $filePath;
        })();
        if (!($workflow instanceof \\Chevere\\Workflow\\Interfaces\\WorkflowInterface)) {
            echo json_encode(['ok' => true]);
            exit(0);
        }
        $jobs = $workflow->jobs();
        if (!$jobs->has($jobName)) {
            echo json_encode(['ok' => true]);
            exit(0);
        }
        $action = $jobs->get($jobName)->action();
        if (!($action instanceof \\Closure)) {
            echo json_encode(['ok' => true]);
            exit(0);
        }
        $ref = new ReflectionFunction($action);
        foreach ($ref->getParameters() as $refParam) {
            if ($refParam->getName() !== $paramName) continue;
            $attributes = $refParam->getAttributes(
                \\Chevere\\Parameter\\Interfaces\\ParameterAttributeInterface::class,
                \\ReflectionAttribute::IS_INSTANCEOF
            );
            foreach ($attributes as $attribute) {
                if ($attribute->getName() !== $attrClass) continue;
                try {
                    $attr = $attribute->newInstance();
                    $attr($value);
                } catch (\\InvalidArgumentException $e) {
                    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
                    exit(0);
                } catch (\\Throwable) {
                    // Instantiation or invocation errors that are not constraint
                    // violations — skip silently to avoid false positives.
                }
            }
            break;
        }
        echo json_encode(['ok' => true]);
    } catch (\\Throwable) {
        echo json_encode(['ok' => true]);
    }
    exit(0);
}

// Structured path: used for reflection-based attributes (named classes).
// Args are already fully resolved by PHP's ReflectionAttribute::getArguments().
if (!class_exists($attrClass)) {
    echo json_encode(['ok' => false, 'error' => "Attribute class not found: $attrClass"]);
    exit(1);
}

try {
    $attrArgs = json_decode($argsJson, true, 512, JSON_THROW_ON_ERROR);
    $attr = new $attrClass(...$attrArgs);
    $attr($value);
    echo json_encode(['ok' => true]);
} catch (\\InvalidArgumentException $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
} catch (\\Throwable) {
    echo json_encode(['ok' => true]);
}
`;

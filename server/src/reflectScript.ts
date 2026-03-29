/**
 * reflect.php is spawned by the LSP server to extract parameter information
 * from PHP classes using reflection. It outputs JSON to stdout.
 *
 * Usage: php reflect.php <autoloader_path> <ClassName>
 *
 * Output JSON shape:
 * {
 *   "ok": true,
 *   "params": [
 *     { "name": "userId", "type": "int", "nullable": false, "hasDefault": false, "default": null }
 *   ],
 *   "returnType": "string"
 * }
 */
export const REFLECT_PHP_SCRIPT = /* php */ `<?php
declare(strict_types=1);

$_args = array_slice($argv, 1);
$autoloader = $_args[0] ?? null;
$className = $_args[1] ?? null;
$methodName = $_args[2] ?? null;

if (!file_exists($autoloader)) {
    echo json_encode(['ok' => false, 'error' => "Autoloader not found: $autoloader"]);
    exit(1);
}

require $autoloader;

if (!class_exists($className)) {
    echo json_encode(['ok' => false, 'error' => "Class not found: $className"]);
    exit(1);
}

try {
    $ref = new ReflectionClass($className);

    // Support explicit method name (from array callables), then common action methods
    $method = null;
    $candidates = $methodName
        ? [$methodName, '__invoke', 'run', 'handle', 'execute']
        : ['__invoke', 'run', 'handle', 'execute'];
    foreach ($candidates as $candidate) {
        if ($ref->hasMethod($candidate)) {
            $method = $ref->getMethod($candidate);
            break;
        }
    }

    if (!$method) {
        echo json_encode(['ok' => false, 'error' => "No invokable method found on $className"]);
        exit(1);
    }

    $params = [];
    foreach ($method->getParameters() as $param) {
        $type = $param->getType();
        $typeName = null;
        if ($type instanceof ReflectionNamedType) {
            $typeName = $type->getName();
        } elseif ($type instanceof ReflectionUnionType) {
            $typeName = implode('|', array_map(fn($t) => $t->getName(), $type->getTypes()));
        } elseif ($type instanceof ReflectionIntersectionType) {
            $typeName = implode('&', array_map(fn($t) => $t->getName(), $type->getTypes()));
        }

        $default = null;
        if ($param->isDefaultValueAvailable()) {
            try { $default = json_encode($param->getDefaultValue()); }
            catch (Throwable) { $default = '?'; }
        }

        $attrs = [];
        foreach ($param->getAttributes() as $attr) {
            $attrName = $attr->getName();
            $pos = strrpos($attrName, '\\\\');
            $shortName = $pos !== false ? substr($attrName, $pos + 1) : $attrName;
            $attrArgs = $attr->getArguments();
            $argStrs = [];
            foreach ($attrArgs as $k => $arg) {
                if (is_string($arg)) {
                    $strVal = "'" . $arg . "'";
                } elseif (is_bool($arg)) {
                    $strVal = $arg ? 'true' : 'false';
                } elseif (is_null($arg)) {
                    $strVal = 'null';
                } else {
                    $strVal = (string) $arg;
                }
                $argStrs[] = is_int($k) ? $strVal : "$k: $strVal";
            }
            $attrs[] = [
                'class'     => $attrName,
                'shortName' => $shortName,
                'args'      => $attrArgs,
                'display'   => '#[' . $shortName . ($argStrs ? '(' . implode(', ', $argStrs) . ')' : '') . ']',
            ];
        }

        $params[] = [
            'name'       => $param->getName(),
            'type'       => $typeName,
            'nullable'   => $type?->allowsNull() ?? true,
            'hasDefault' => $param->isDefaultValueAvailable(),
            'default'    => $default,
            'position'   => $param->getPosition(),
            'variadic'   => $param->isVariadic(),
            'attributes' => $attrs,
        ];
    }

    $returnType = $method->getReturnType();
    $returnTypeName = null;
    if ($returnType instanceof ReflectionNamedType) {
        $returnTypeName = $returnType->getName();
    }

    // For Chevere Action classes: call static reflection()->return() to get
    // the ParameterInterface, then if it implements ParametersAccessInterface
    // enumerate its named keys and their types.
    $returnKeys = null;
    if ($ref->hasMethod('reflection') && $ref->getMethod('reflection')->isStatic()) {
        try {
            $actionReflection = $className::reflection();
            $returnParam = $actionReflection->return();
            if ($returnParam instanceof \\Chevere\\Parameter\\Interfaces\\ParametersAccessInterface) {
                $returnKeys = [];
                $parameters = $returnParam->parameters();
                $allKeys = array_merge(
                    $parameters->requiredKeys()->toArray(),
                    $parameters->optionalKeys()->toArray()
                );
                foreach ($allKeys as $keyName) {
                    $keyParam = $parameters->get($keyName);
                    $keyRef = new ReflectionClass($keyParam);
                    $interfaces = $keyRef->getInterfaceNames();
                    $keyType = null;
                    if (in_array('Chevere\\Parameter\\Interfaces\\StringParameterInterface', $interfaces)) {
                        $keyType = 'string';
                    } elseif (in_array('Chevere\\Parameter\\Interfaces\\IntParameterInterface', $interfaces)) {
                        $keyType = 'int';
                    } elseif (in_array('Chevere\\Parameter\\Interfaces\\FloatParameterInterface', $interfaces)) {
                        $keyType = 'float';
                    } elseif (in_array('Chevere\\Parameter\\Interfaces\\BoolParameterInterface', $interfaces)) {
                        $keyType = 'bool';
                    } elseif (in_array('Chevere\\Parameter\\Interfaces\\ArrayParameterInterface', $interfaces)) {
                        $keyType = 'array';
                    } elseif (in_array('Chevere\\Parameter\\Interfaces\\NullParameterInterface', $interfaces)) {
                        $keyType = 'null';
                    }
                    $returnKeys[$keyName] = $keyType;
                }
            }
        } catch (Throwable) {
            $returnKeys = null;
        }
    }

    // If the return type is a class (not a built-in), reflect its public properties
    $returnClassProperties = null;
    if ($returnTypeName !== null && $returnKeys === null) {
        $builtins = ['string', 'int', 'float', 'bool', 'array', 'void', 'null', 'never',
                     'self', 'static', 'mixed', 'object', 'iterable', 'callable', 'true', 'false'];
        if (!in_array($returnTypeName, $builtins) && class_exists($returnTypeName)) {
            try {
                $returnClassRef = new ReflectionClass($returnTypeName);
                $returnClassProperties = [];
                foreach ($returnClassRef->getProperties(ReflectionProperty::IS_PUBLIC) as $prop) {
                    $propType = $prop->getType();
                    $propTypeName = null;
                    if ($propType instanceof ReflectionNamedType) {
                        $propTypeName = $propType->getName();
                    }
                    $returnClassProperties[$prop->getName()] = $propTypeName;
                }
            } catch (Throwable) {
                $returnClassProperties = null;
            }
        }
    }

    echo json_encode([
        'ok'                    => true,
        'class'                 => $className,
        'method'                => $method->getName(),
        'params'                => $params,
        'returnType'            => $returnTypeName,
        'returnKeys'            => $returnKeys,
        'returnClassProperties' => $returnClassProperties,
    ]);
} catch (Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(1);
}
`;

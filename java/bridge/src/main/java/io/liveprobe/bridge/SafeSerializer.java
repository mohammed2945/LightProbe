package io.liveprobe.bridge;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Applies redaction and limits while traversing raw capture values. */
final class SafeSerializer {
    private SafeSerializer() {}

    static Map<String, Object> serialize(Object raw, Config config) {
        return new Walker(config).walk(raw, 0, null);
    }

    static Map<String, Object> serializeProperty(String key, Object raw, Config config) {
        if (config.isRedactedKey(key)) {
            return node("redacted");
        }
        return new Walker(config).walk(raw, 0, key);
    }

    static Map<String, Object> serializePath(String path, Object raw, Config config) {
        for (String segment : path.split("\\.", -1)) {
            if (config.isRedactedKey(segment)) {
                return node("redacted");
            }
        }
        int separator = path.lastIndexOf('.');
        String finalKey = separator < 0 ? path : path.substring(separator + 1);
        return serializeProperty(finalKey, raw, config);
    }

    static String render(Map<String, Object> node) {
        String type = String.valueOf(node.get("t"));
        return switch (type) {
            case "str", "num", "bool" -> String.valueOf(node.get("v"));
            case "null" -> "null";
            case "redacted" -> "[REDACTED]";
            case "fn" -> "[function]";
            case "truncated" -> "[truncated:" + node.get("v") + "]";
            case "arr" -> renderArray(node);
            case "obj" -> renderObject(node);
            default -> "[unsupported]";
        };
    }

    private static String renderArray(Map<String, Object> node) {
        Object children = node.get("c");
        if (!(children instanceof List<?> list)) {
            return "[]";
        }
        ArrayList<String> values = new ArrayList<>();
        for (Object child : list) {
            values.add(child instanceof Map<?, ?> map ? render(Json.stringMap(map)) : "[unsupported]");
        }
        if (node.containsKey("m")) {
            values.add("...");
        }
        return "[" + String.join(", ", values) + "]";
    }

    private static String renderObject(Map<String, Object> node) {
        Object children = node.get("c");
        if (!(children instanceof Map<?, ?> map)) {
            return "{}";
        }
        Map<String, Object> properties = Json.stringMap(map);
        String typeName = null;
        ArrayList<String> values = new ArrayList<>();
        for (Map.Entry<String, Object> entry : properties.entrySet()) {
            if ("$type".equals(entry.getKey()) && entry.getValue() instanceof Map<?, ?> typeNode) {
                Object value = typeNode.get("v");
                typeName = value instanceof String text ? text : null;
                continue;
            }
            String rendered = entry.getValue() instanceof Map<?, ?> child
                    ? render(Json.stringMap(child))
                    : "[unsupported]";
            values.add(entry.getKey() + "=" + rendered);
        }
        if (node.containsKey("m")) {
            values.add("...");
        }
        return (typeName == null ? "" : typeName) + "{" + String.join(", ", values) + "}";
    }

    private static Map<String, Object> node(String type) {
        LinkedHashMap<String, Object> node = new LinkedHashMap<>();
        node.put("t", type);
        return node;
    }

    private static Map<String, Object> node(String type, Object value) {
        LinkedHashMap<String, Object> node = new LinkedHashMap<>();
        node.put("t", type);
        node.put("v", value);
        return node;
    }

    static final class Config {
        private static final List<String> DEFAULT_REDACT_KEYS = List.of(
                "password", "secret", "token", "authorization", "cookie", "key",
                "signature", "ssn", "creditcard");

        private final int maxDepth;
        private final int maxArray;
        private final int maxProps;
        private final int maxString;
        private final int maxStackFrames;
        private final List<String> redactKeys;
        private final Set<String> redactValues;

        Config(
                int maxDepth,
                int maxArray,
                int maxProps,
                int maxString,
                int maxStackFrames,
                List<String> additionalRedactKeys,
                List<String> redactValues) {
            this.maxDepth = nonNegative("maxDepth", maxDepth);
            this.maxArray = nonNegative("maxArray", maxArray);
            this.maxProps = nonNegative("maxProps", maxProps);
            this.maxString = nonNegative("maxString", maxString);
            this.maxStackFrames = nonNegative("maxStackFrames", maxStackFrames);

            LinkedHashSet<String> keys = new LinkedHashSet<>();
            for (String key : DEFAULT_REDACT_KEYS) {
                keys.add(key);
            }
            for (String key : additionalRedactKeys) {
                if (key != null && !key.isBlank()) {
                    keys.add(key.toLowerCase(Locale.ROOT));
                }
            }
            this.redactKeys = List.copyOf(keys);
            this.redactValues = Collections.unmodifiableSet(new LinkedHashSet<>(redactValues));
        }

        static Config defaults() {
            return new Config(3, 3, 50, 1024, 8, List.of(), List.of());
        }

        static Config fromJson(Map<String, Object> config) {
            Config defaults = defaults();
            return new Config(
                    integer(config, "maxDepth", defaults.maxDepth),
                    integer(config, "maxArray", defaults.maxArray),
                    integer(config, "maxProps", defaults.maxProps),
                    integer(config, "maxString", defaults.maxString),
                    integer(config, "maxStackFrames", defaults.maxStackFrames),
                    strings(config.get("redactKeys")),
                    strings(config.get("redactValues")));
        }

        int maxProps() {
            return maxProps;
        }

        int maxStackFrames() {
            return maxStackFrames;
        }

        boolean isRedactedKey(String key) {
            if (key == null) {
                return false;
            }
            String normalized = key.toLowerCase(Locale.ROOT);
            for (String pattern : redactKeys) {
                if (normalized.contains(pattern)) {
                    return true;
                }
            }
            return false;
        }

        boolean isRedactedValue(String value) {
            return redactValues.contains(value);
        }

        private static int integer(Map<String, Object> config, String key, int fallback) {
            Object value = config.get(key);
            if (value == null) {
                return fallback;
            }
            if (!(value instanceof Number number)) {
                throw new IllegalArgumentException(key + " must be a non-negative integer");
            }
            BigDecimal decimal = new BigDecimal(number.toString());
            try {
                return nonNegative(key, decimal.intValueExact());
            } catch (ArithmeticException exception) {
                throw new IllegalArgumentException(key + " must be a non-negative integer");
            }
        }

        private static List<String> strings(Object value) {
            if (value == null) {
                return List.of();
            }
            if (!(value instanceof List<?> list)) {
                throw new IllegalArgumentException("redaction values must be arrays");
            }
            ArrayList<String> strings = new ArrayList<>();
            for (Object item : list) {
                if (!(item instanceof String text)) {
                    throw new IllegalArgumentException("redaction values must contain strings");
                }
                strings.add(text);
            }
            return strings;
        }

        private static int nonNegative(String name, int value) {
            if (value < 0) {
                throw new IllegalArgumentException(name + " must be non-negative");
            }
            return value;
        }
    }

    private static final class Walker {
        private final Config config;
        private final IdentityHashMap<Object, Boolean> active = new IdentityHashMap<>();

        private Walker(Config config) {
            this.config = config;
        }

        private Map<String, Object> walk(Object raw, int depth, String key) {
            if (raw == RawRedacted.INSTANCE || key != null && config.isRedactedKey(key)) {
                return node("redacted");
            }
            if (raw instanceof String text && config.isRedactedValue(text)) {
                return node("redacted");
            }
            if (depth > config.maxDepth) {
                return node("truncated", "depth");
            }
            if (raw == null) {
                return node("null", null);
            }
            if (raw == RawFunction.INSTANCE) {
                return node("fn");
            }
            if (raw instanceof String text) {
                if (text.codePointCount(0, text.length()) > config.maxString) {
                    return node("truncated", "string");
                }
                return node("str", text);
            }
            if (raw instanceof Character character) {
                return node("str", character.toString());
            }
            if (raw instanceof Boolean bool) {
                return node("bool", bool);
            }
            if (raw instanceof Number number) {
                boolean finite = !(number instanceof Double)
                        || Double.isFinite(number.doubleValue());
                finite = finite && (!(number instanceof Float)
                        || Float.isFinite(number.floatValue()));
                if (!finite) {
                    return node("truncated", "unsupported");
                }
                return node("num", number);
            }
            if (raw instanceof JdiObjectReference reference) {
                return node("str", reference.typeName() + "{...}");
            }
            if (raw instanceof JdiObjectSummary summary) {
                return walkObjectSummary(summary, depth);
            }
            if (raw instanceof Map<?, ?> map) {
                return walkMap(map, depth);
            }
            if (raw instanceof Iterable<?> iterable) {
                return walkIterable(raw, iterable, depth);
            }
            if (raw.getClass().isArray()) {
                return walkArray(raw, depth);
            }
            return node("truncated", "unsupported");
        }

        private Map<String, Object> walkObjectSummary(JdiObjectSummary summary, int depth) {
            if (active.put(summary, Boolean.TRUE) != null) {
                return node("truncated", "circular");
            }
            try {
                LinkedHashMap<String, Object> children = new LinkedHashMap<>();
                int retained = 0;
                boolean omitted = false;
                if (retained < config.maxProps) {
                    children.put("$type", walk(summary.typeName(), depth + 1, "$type"));
                    retained++;
                } else {
                    omitted = true;
                }
                for (Map.Entry<String, Object> entry : summary.fields().entrySet()) {
                    if (retained >= config.maxProps) {
                        omitted = true;
                        break;
                    }
                    String fieldName = entry.getKey();
                    if (config.isRedactedKey(fieldName)) {
                        children.put(fieldName, node("redacted"));
                    } else {
                        children.put(fieldName, walk(entry.getValue(), depth + 1, fieldName));
                    }
                    retained++;
                }
                return container("obj", children, omitted ? "props" : null);
            } finally {
                active.remove(summary);
            }
        }

        private Map<String, Object> walkMap(Map<?, ?> map, int depth) {
            if (active.put(map, Boolean.TRUE) != null) {
                return node("truncated", "circular");
            }
            try {
                LinkedHashMap<String, Object> children = new LinkedHashMap<>();
                int retained = 0;
                boolean omitted = false;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String property)) {
                        continue;
                    }
                    if (retained >= config.maxProps) {
                        omitted = true;
                        break;
                    }
                    if (config.isRedactedKey(property)) {
                        children.put(property, node("redacted"));
                    } else {
                        children.put(property, walk(entry.getValue(), depth + 1, property));
                    }
                    retained++;
                }
                return container("obj", children, omitted ? "props" : null);
            } finally {
                active.remove(map);
            }
        }

        private Map<String, Object> walkIterable(Object identity, Iterable<?> iterable, int depth) {
            if (active.put(identity, Boolean.TRUE) != null) {
                return node("truncated", "circular");
            }
            try {
                ArrayList<Object> children = new ArrayList<>();
                boolean omitted = false;
                int seen = 0;
                for (Object value : iterable) {
                    if (seen >= config.maxArray) {
                        omitted = true;
                        break;
                    }
                    children.add(walk(value, depth + 1, null));
                    seen++;
                }
                return container("arr", children, omitted ? "array" : null);
            } finally {
                active.remove(identity);
            }
        }

        private Map<String, Object> walkArray(Object array, int depth) {
            if (active.put(array, Boolean.TRUE) != null) {
                return node("truncated", "circular");
            }
            try {
                int length = Array.getLength(array);
                int retained = Math.min(length, config.maxArray);
                ArrayList<Object> children = new ArrayList<>(retained);
                for (int index = 0; index < retained; index++) {
                    children.add(walk(Array.get(array, index), depth + 1, null));
                }
                return container("arr", children, retained < length ? "array" : null);
            } finally {
                active.remove(array);
            }
        }

        private Map<String, Object> container(String type, Object children, String marker) {
            LinkedHashMap<String, Object> node = new LinkedHashMap<>();
            node.put("t", type);
            node.put("c", children);
            if (marker != null) {
                node.put("m", SafeSerializer.node("truncated", marker));
            }
            return node;
        }
    }
}

enum RawFunction {
    INSTANCE
}

enum RawRedacted {
    INSTANCE
}

record JdiObjectReference(String typeName) {}

record JdiObjectSummary(String typeName, Map<String, Object> fields) {}

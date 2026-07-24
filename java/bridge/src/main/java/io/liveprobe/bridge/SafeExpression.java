package io.liveprobe.bridge;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Validates and evaluates the broker's portable, non-executable expression AST. */
final class SafeExpression {
    private static final int MAX_SOURCE_LENGTH = 4_096;
    private static final int MAX_AST_DEPTH = 20;
    private static final int MAX_AST_NODES = 100;
    private static final int MAX_PATH_SEGMENTS = 64;
    private static final int MAX_PATH_STRING_LENGTH = 128;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final int MAX_TEMPLATE_SEGMENTS = 201;
    private static final int MAX_TEMPLATE_TEXT_LENGTH = 16_384;
    private static final int MAX_RENDERED_TEMPLATE_LENGTH = 4_096;
    private static final Set<String> FORBIDDEN_SEGMENTS =
            Set.of("__proto__", "prototype", "constructor");
    private static final Set<String> UNARY_OPERATORS = Set.of("not", "negate");
    private static final Set<String> BINARY_OPERATORS = Set.of(
            "add", "subtract", "multiply", "divide", "modulo",
            "eq", "ne", "gt", "gte", "lt", "lte", "and", "or");
    private static final Set<String> ORDERING_OPERATORS = Set.of("gt", "gte", "lt", "lte");

    private SafeExpression() {}

    record Compiled(String source, Node ast) {}

    sealed interface Node permits Literal, Reference, Unary, Binary {}

    record Literal(Object value) implements Node {}

    record Reference(List<Object> path) implements Node {
        Reference {
            path = List.copyOf(path);
        }
    }

    record Unary(String operator, Node operand) implements Node {}

    record Binary(String operator, Node left, Node right) implements Node {}

    sealed interface TemplateSegment permits TextSegment, ExpressionSegment {}

    record TextSegment(String value) implements TemplateSegment {}

    record ExpressionSegment(Compiled expression) implements TemplateSegment {}

    record Result(boolean ok, Object value, String error) {
        static Result success(Object value) {
            return new Result(true, value, null);
        }

        static Result failure(String error) {
            return new Result(false, null, error);
        }
    }

    static Compiled parseCompiled(Object raw, String name) {
        Map<String, Object> object = object(raw, name);
        exactKeys(object, name, Set.of("source", "ast"));
        Object rawSource = object.get("source");
        if (!(rawSource instanceof String source)
                || source.isBlank()
                || source.length() > MAX_SOURCE_LENGTH) {
            throw invalid(name + ".source must contain 1 to 4096 characters");
        }
        ValidationState state = new ValidationState();
        Node ast = parseNode(object.get("ast"), name + ".ast", state, 0);
        return new Compiled(source, ast);
    }

    static Compiled parseOptionalCompiled(Object raw, String name) {
        return raw == null ? null : parseCompiled(raw, name);
    }

    static List<Compiled> parseCompiledList(Object raw, String name) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list) || list.size() > MAX_AST_NODES) {
            throw invalid(name + " must be an array with at most 100 expressions");
        }
        ArrayList<Compiled> expressions = new ArrayList<>(list.size());
        for (int index = 0; index < list.size(); index++) {
            expressions.add(parseCompiled(list.get(index), name + "[" + index + "]"));
        }
        return List.copyOf(expressions);
    }

    static List<TemplateSegment> parseTemplateSegments(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list) || list.size() > MAX_TEMPLATE_SEGMENTS) {
            throw invalid("templateSegments must be an array with at most 201 segments");
        }
        ArrayList<TemplateSegment> segments = new ArrayList<>(list.size());
        for (int index = 0; index < list.size(); index++) {
            String name = "templateSegments[" + index + "]";
            Map<String, Object> segment = object(list.get(index), name);
            Object rawType = segment.get("type");
            if ("text".equals(rawType)) {
                exactKeys(segment, name, Set.of("type", "value"));
                Object rawValue = segment.get("value");
                if (!(rawValue instanceof String value)
                        || value.length() > MAX_TEMPLATE_TEXT_LENGTH) {
                    throw invalid(name + ".value must be a string of at most 16384 characters");
                }
                segments.add(new TextSegment(value));
            } else if ("expression".equals(rawType)) {
                exactKeys(segment, name, Set.of("type", "expression"));
                segments.add(new ExpressionSegment(
                        parseCompiled(segment.get("expression"), name + ".expression")));
            } else {
                throw invalid(name + ".type is unsupported");
            }
        }
        return List.copyOf(segments);
    }

    static Result evaluate(
            Compiled expression,
            Map<String, Object> variables,
            SafeSerializer.Config serializerConfig) {
        return evaluateNode(expression.ast(), variables, serializerConfig);
    }

    static String renderTemplate(
            List<TemplateSegment> segments,
            Map<String, Object> variables,
            SafeSerializer.Config serializerConfig) {
        StringBuilder rendered = new StringBuilder();
        for (TemplateSegment segment : segments) {
            if (segment instanceof TextSegment text) {
                rendered.append(text.value());
            } else if (segment instanceof ExpressionSegment expression) {
                Result result = evaluate(expression.expression(), variables, serializerConfig);
                if (result.ok()) {
                    rendered.append(renderValue(result.value()));
                } else {
                    rendered.append("<expression-error:")
                            .append(result.error())
                            .append('>');
                }
            }
            if (rendered.codePointCount(0, rendered.length()) >= MAX_RENDERED_TEMPLATE_LENGTH) {
                return rendered.codePoints()
                        .limit(MAX_RENDERED_TEMPLATE_LENGTH)
                        .collect(
                                StringBuilder::new,
                                StringBuilder::appendCodePoint,
                                StringBuilder::append)
                        .toString();
            }
        }
        return rendered.toString();
    }

    static Map<String, Object> unsupportedMarker() {
        LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
        marker.put("t", "truncated");
        marker.put("v", "unsupported");
        return marker;
    }

    private static Node parseNode(
            Object raw,
            String name,
            ValidationState state,
            int depth) {
        state.nodes++;
        if (state.nodes > MAX_AST_NODES) {
            throw invalid(name + " exceeds the 100-node limit");
        }
        if (depth > MAX_AST_DEPTH) {
            throw invalid(name + " exceeds the depth limit of 20");
        }
        Map<String, Object> node = object(raw, name);
        Object rawType = node.get("type");
        if ("literal".equals(rawType)) {
            exactKeys(node, name, Set.of("type", "value"));
            Object value = node.get("value");
            if (!isJsonScalar(value)) {
                throw invalid(name + ".value must be a finite JSON scalar");
            }
            return new Literal(value);
        }
        if ("reference".equals(rawType)) {
            exactKeys(node, name, Set.of("type", "path"));
            return new Reference(parsePath(node.get("path"), name + ".path"));
        }
        if ("unary".equals(rawType)) {
            exactKeys(node, name, Set.of("type", "operator", "operand"));
            String operator = operator(node.get("operator"), name, UNARY_OPERATORS);
            return new Unary(
                    operator,
                    parseNode(node.get("operand"), name + ".operand", state, depth + 1));
        }
        if ("binary".equals(rawType)) {
            exactKeys(node, name, Set.of("type", "operator", "left", "right"));
            String operator = operator(node.get("operator"), name, BINARY_OPERATORS);
            return new Binary(
                    operator,
                    parseNode(node.get("left"), name + ".left", state, depth + 1),
                    parseNode(node.get("right"), name + ".right", state, depth + 1));
        }
        throw invalid(name + ".type is unsupported");
    }

    private static List<Object> parsePath(Object raw, String name) {
        if (!(raw instanceof List<?> path)
                || path.isEmpty()
                || path.size() > MAX_PATH_SEGMENTS) {
            throw invalid(name + " must contain 1 to 64 fixed segments");
        }
        ArrayList<Object> segments = new ArrayList<>(path.size());
        for (Object segment : path) {
            if (segment instanceof String value) {
                if (value.isEmpty()
                        || value.length() > MAX_PATH_STRING_LENGTH
                        || FORBIDDEN_SEGMENTS.contains(value)) {
                    throw invalid(name + " contains a forbidden property segment");
                }
                segments.add(value);
                continue;
            }
            if (segment instanceof Number number) {
                long index = exactNonNegativeInteger(number, name);
                if (index > MAX_SAFE_INTEGER) {
                    throw invalid(name + " contains an unsafe integer segment");
                }
                segments.add(index);
                continue;
            }
            throw invalid(name + " segments must be strings or non-negative integers");
        }
        return List.copyOf(segments);
    }

    private static Result evaluateNode(
            Node node,
            Map<String, Object> variables,
            SafeSerializer.Config serializerConfig) {
        if (node instanceof Literal literal) {
            return safeResult(literal.value(), serializerConfig);
        }
        if (node instanceof Reference reference) {
            return resolve(variables, reference.path(), serializerConfig);
        }
        if (node instanceof Unary unary) {
            Result operand = evaluateNode(unary.operand(), variables, serializerConfig);
            if (!operand.ok()) {
                return operand;
            }
            if ("not".equals(unary.operator())) {
                return operand.value() instanceof Boolean value
                        ? Result.success(!value)
                        : Result.failure("expected-boolean");
            }
            if (!(operand.value() instanceof Number number) || !finite(number)) {
                return Result.failure(numericError(operand.value()));
            }
            double value = -number.doubleValue();
            return safeNumericResult(value);
        }

        Binary binary = (Binary) node;
        Result left = evaluateNode(binary.left(), variables, serializerConfig);
        if (!left.ok()) {
            return left;
        }
        if ("and".equals(binary.operator()) || "or".equals(binary.operator())) {
            if (!(left.value() instanceof Boolean leftBoolean)) {
                return Result.failure("expected-boolean");
            }
            if ("and".equals(binary.operator()) && !leftBoolean) {
                return Result.success(false);
            }
            if ("or".equals(binary.operator()) && leftBoolean) {
                return Result.success(true);
            }
            Result right = evaluateNode(binary.right(), variables, serializerConfig);
            if (!right.ok()) {
                return right;
            }
            return right.value() instanceof Boolean
                    ? right
                    : Result.failure("expected-boolean");
        }

        Result right = evaluateNode(binary.right(), variables, serializerConfig);
        if (!right.ok()) {
            return right;
        }
        if ("eq".equals(binary.operator()) || "ne".equals(binary.operator())) {
            if (!isJsonScalar(left.value()) || !isJsonScalar(right.value())) {
                return Result.failure("expected-scalars");
            }
            boolean equal = scalarEquals(left.value(), right.value());
            return Result.success("eq".equals(binary.operator()) ? equal : !equal);
        }
        if (ORDERING_OPERATORS.contains(binary.operator())) {
            if (!(left.value() instanceof Number leftNumber)
                    || !(right.value() instanceof Number rightNumber)
                    || !portableNumber(leftNumber)
                    || !portableNumber(rightNumber)) {
                return Result.failure(numericError(left.value(), right.value()));
            }
            int comparison = Double.compare(
                    leftNumber.doubleValue(), rightNumber.doubleValue());
            return Result.success(switch (binary.operator()) {
                case "gt" -> comparison > 0;
                case "gte" -> comparison >= 0;
                case "lt" -> comparison < 0;
                default -> comparison <= 0;
            });
        }
        if ("add".equals(binary.operator())
                && left.value() instanceof String leftString
                && right.value() instanceof String rightString) {
            return safeResult(leftString + rightString, serializerConfig);
        }
        if (!(left.value() instanceof Number leftNumber)
                || !(right.value() instanceof Number rightNumber)
                || !portableNumber(leftNumber)
                || !portableNumber(rightNumber)) {
            return Result.failure(numericError(left.value(), right.value()));
        }
        double leftValue = leftNumber.doubleValue();
        double rightValue = rightNumber.doubleValue();
        double value;
        switch (binary.operator()) {
            case "add" -> value = leftValue + rightValue;
            case "subtract" -> value = leftValue - rightValue;
            case "multiply" -> value = leftValue * rightValue;
            case "divide" -> {
                if (rightValue == 0) {
                    return Result.failure("division-by-zero");
                }
                value = leftValue / rightValue;
            }
            case "modulo" -> {
                if (rightValue == 0) {
                    return Result.failure("division-by-zero");
                }
                value = leftValue % rightValue;
            }
            default -> {
                return Result.failure("unsupported-operator");
            }
        }
        return safeNumericResult(value);
    }

    private static Result resolve(
            Object root,
            List<Object> path,
            SafeSerializer.Config serializerConfig) {
        Object current = root;
        for (Object segment : path) {
            if (segment instanceof String property && serializerConfig.isRedactedKey(property)) {
                return Result.failure("redacted");
            }
            if (current == RawRedacted.INSTANCE) {
                return Result.failure("redacted");
            }
            if (current == RawFunction.INSTANCE || current instanceof JdiObjectReference) {
                return Result.failure("capture-truncated");
            }
            if (current instanceof JdiObjectSummary summary) {
                String property = String.valueOf(segment);
                if (!summary.fields().containsKey(property)) {
                    return Result.failure("missing");
                }
                current = summary.fields().get(property);
            } else if (current instanceof Map<?, ?> map) {
                String property = String.valueOf(segment);
                if (!map.containsKey(property)) {
                    return Result.failure("missing");
                }
                current = map.get(property);
            } else if (current instanceof List<?> list) {
                long position = listIndex(segment);
                if (position < 0 || position >= list.size()) {
                    return Result.failure("missing");
                }
                current = list.get((int) position);
            } else {
                return Result.failure("missing");
            }
        }
        if (current == RawRedacted.INSTANCE) {
            return Result.failure("redacted");
        }
        if (current == RawFunction.INSTANCE || current instanceof JdiObjectReference) {
            return Result.failure("capture-truncated");
        }
        return safeResult(current, serializerConfig);
    }

    private static long listIndex(Object segment) {
        if (segment instanceof Number number) {
            return number.longValue();
        }
        if (!(segment instanceof String text)
                || text.isEmpty()
                || text.length() > 1 && text.charAt(0) == '0') {
            return -1;
        }
        for (int index = 0; index < text.length(); index++) {
            if (text.charAt(index) < '0' || text.charAt(index) > '9') {
                return -1;
            }
        }
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException exception) {
            return -1;
        }
    }

    private static Result safeResult(Object value, SafeSerializer.Config serializerConfig) {
        if (value instanceof Number number && !portableNumber(number)) {
            return Result.failure("unsafe-number");
        }
        if (value instanceof String text && serializerConfig.isRedactedValue(text)) {
            return Result.failure("redacted");
        }
        return Result.success(value);
    }

    private static boolean scalarEquals(Object left, Object right) {
        if (left == null || right == null) {
            return left == right;
        }
        if (left instanceof Number leftNumber && right instanceof Number rightNumber) {
            return portableNumber(leftNumber)
                    && portableNumber(rightNumber)
                    && leftNumber.doubleValue() == rightNumber.doubleValue();
        }
        return left.getClass() == right.getClass() && left.equals(right);
    }

    private static String renderValue(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String || value instanceof Boolean) {
            return String.valueOf(value);
        }
        if (value instanceof Double number) {
            return renderFloatingPoint(number);
        }
        if (value instanceof Float number) {
            return renderFloatingPoint(number.doubleValue());
        }
        if (value instanceof Number number) {
            return String.valueOf(number);
        }
        if (value instanceof List<?>) {
            return "[array]";
        }
        if (value instanceof Map<?, ?> || value instanceof JdiObjectSummary) {
            return "[object]";
        }
        return "[unavailable]";
    }

    private static String renderFloatingPoint(double value) {
        if (value == 0) {
            return "0";
        }
        BigDecimal decimal = BigDecimal.valueOf(value).stripTrailingZeros();
        double absolute = Math.abs(value);
        if (absolute >= 1e21 || absolute < 1e-6) {
            return decimal.toString().replace('E', 'e');
        }
        return decimal.toPlainString();
    }

    private static boolean isJsonScalar(Object value) {
        return value == null
                || value instanceof String
                || value instanceof Boolean
                || value instanceof Number number && portableNumber(number);
    }

    private static Result safeNumericResult(double value) {
        if (!Double.isFinite(value)) {
            return Result.failure("non-finite-result");
        }
        return portableNumber(value)
                ? Result.success(value)
                : Result.failure("unsafe-number");
    }

    private static String numericError(Object... values) {
        for (Object value : values) {
            if (value instanceof Number number && !portableNumber(number)) {
                return "unsafe-number";
            }
        }
        return values.length == 1 ? "expected-number" : "expected-numbers";
    }

    private static boolean portableNumber(Number number) {
        if (!finite(number)) {
            return false;
        }
        double value = number.doubleValue();
        return value != Math.rint(value) || Math.abs(value) <= MAX_SAFE_INTEGER;
    }

    private static boolean finite(Number number) {
        if (number instanceof Double value) {
            return Double.isFinite(value);
        }
        if (number instanceof Float value) {
            return Float.isFinite(value);
        }
        try {
            decimal(number);
            return true;
        } catch (NumberFormatException exception) {
            return false;
        }
    }

    private static BigDecimal decimal(Number number) {
        return new BigDecimal(number.toString());
    }

    private static long exactNonNegativeInteger(Number number, String name) {
        try {
            long value = decimal(number).longValueExact();
            if (value < 0) {
                throw invalid(name + " contains a negative index");
            }
            return value;
        } catch (NumberFormatException | ArithmeticException exception) {
            throw invalid(name + " contains a non-integer index");
        }
    }

    private static String operator(Object raw, String name, Set<String> supported) {
        if (!(raw instanceof String operator) || !supported.contains(operator)) {
            throw invalid(name + ".operator is unsupported");
        }
        return operator;
    }

    private static Map<String, Object> object(Object raw, String name) {
        if (!(raw instanceof Map<?, ?> map)) {
            throw invalid(name + " must be an object");
        }
        return Json.stringMap(map);
    }

    private static void exactKeys(Map<String, Object> object, String name, Set<String> keys) {
        if (!object.keySet().equals(keys)) {
            throw invalid(name + " has missing or unrecognized fields");
        }
    }

    private static Protocol.ProtocolException invalid(String message) {
        return new Protocol.ProtocolException("invalid safe expression: " + message);
    }

    private static final class ValidationState {
        private int nodes;
    }
}

package io.liveprobe.bridge;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Resolves dot paths and evaluates the protocol's six pure comparison operators. */
final class ConditionEvaluator {
    private static final Object MISSING = new Object();

    private ConditionEvaluator() {}

    static boolean evaluate(Map<String, Object> variables, Protocol.Condition condition) {
        if (condition == null) {
            return true;
        }
        Object actual = resolveOrMissing(variables, condition.path());
        if (actual == MISSING || actual == RawRedacted.INSTANCE) {
            return false;
        }
        Object expected = condition.value();
        Integer comparison = compareNumbers(actual, expected);
        return switch (condition.op()) {
            case "eq" -> scalarEquals(actual, expected);
            case "ne" -> !scalarEquals(actual, expected) && isScalar(actual) && isScalar(expected);
            case "gt" -> comparison != null && comparison > 0;
            case "gte" -> comparison != null && comparison >= 0;
            case "lt" -> comparison != null && comparison < 0;
            case "lte" -> comparison != null && comparison <= 0;
            default -> false;
        };
    }

    static Object resolve(Map<String, Object> variables, String path) {
        Object resolved = resolveOrMissing(variables, path);
        return resolved == MISSING ? null : resolved;
    }

    static boolean exists(Map<String, Object> variables, String path) {
        return resolveOrMissing(variables, path) != MISSING;
    }

    static boolean pathIsRedacted(String path, SafeSerializer.Config config) {
        String[] segments = path.split("\\.", -1);
        for (String segment : segments) {
            if (config.isRedactedKey(segment)) {
                return true;
            }
        }
        return false;
    }

    private static Object resolveOrMissing(Object root, String path) {
        if (path == null || path.isEmpty()) {
            return MISSING;
        }
        Object current = root;
        for (String segment : path.split("\\.", -1)) {
            if (segment.isEmpty()) {
                return MISSING;
            }
            if (current instanceof Map<?, ?> map) {
                if (!map.containsKey(segment)) {
                    return MISSING;
                }
                current = map.get(segment);
            } else if (current instanceof JdiObjectSummary summary) {
                if (!summary.fields().containsKey(segment)) {
                    return MISSING;
                }
                current = summary.fields().get(segment);
            } else if (current instanceof List<?> list) {
                int index = arrayIndex(segment);
                if (index < 0 || index >= list.size()) {
                    return MISSING;
                }
                current = list.get(index);
            } else if (current != null && current.getClass().isArray()) {
                int index = arrayIndex(segment);
                if (index < 0 || index >= Array.getLength(current)) {
                    return MISSING;
                }
                current = Array.get(current, index);
            } else {
                return MISSING;
            }
        }
        return current;
    }

    private static int arrayIndex(String segment) {
        if (segment.isEmpty()) {
            return -1;
        }
        try {
            if (segment.length() > 1 && segment.charAt(0) == '0') {
                return -1;
            }
            int index = Integer.parseInt(segment);
            return index < 0 ? -1 : index;
        } catch (NumberFormatException exception) {
            return -1;
        }
    }

    private static boolean scalarEquals(Object left, Object right) {
        if (!isScalar(left) || !isScalar(right)) {
            return false;
        }
        if (left == null || right == null) {
            return left == right;
        }
        if (left instanceof Number leftNumber && right instanceof Number rightNumber) {
            if (!finite(leftNumber) || !finite(rightNumber)) {
                return false;
            }
            return decimal(leftNumber).compareTo(decimal(rightNumber)) == 0;
        }
        return left.getClass() == right.getClass() && Objects.equals(left, right);
    }

    private static Integer compareNumbers(Object left, Object right) {
        if (!(left instanceof Number leftNumber) || !(right instanceof Number rightNumber)
                || !finite(leftNumber) || !finite(rightNumber)) {
            return null;
        }
        return decimal(leftNumber).compareTo(decimal(rightNumber));
    }

    private static boolean isScalar(Object value) {
        return value == null || value instanceof String || value instanceof Boolean || value instanceof Number;
    }

    private static boolean finite(Number number) {
        if (number instanceof Double value) {
            return Double.isFinite(value);
        }
        if (number instanceof Float value) {
            return Float.isFinite(value);
        }
        return true;
    }

    private static BigDecimal decimal(Number number) {
        return new BigDecimal(number.toString());
    }
}

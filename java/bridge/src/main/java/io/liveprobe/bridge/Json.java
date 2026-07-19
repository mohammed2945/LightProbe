package io.liveprobe.bridge;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Minimal dependency-free JSON parser and writer for broker traffic and tests. */
final class Json {
    private Json() {}

    static Object parse(String input) {
        if (input == null) {
            throw new JsonException("JSON input must not be null");
        }
        Parser parser = new Parser(input);
        Object value = parser.parseValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw parser.error("unexpected trailing content");
        }
        return value;
    }

    static Map<String, Object> parseObject(String input) {
        Object value = parse(input);
        if (!(value instanceof Map<?, ?> map)) {
            throw new JsonException("expected a JSON object");
        }
        return stringMap(map);
    }

    static String stringify(Object value) {
        StringBuilder output = new StringBuilder();
        write(value, output);
        return output.toString();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> stringMap(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    private static void write(Object value, StringBuilder output) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String text) {
            writeString(text, output);
        } else if (value instanceof Boolean bool) {
            output.append(bool);
        } else if (value instanceof Number number) {
            writeNumber(number, output);
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            Iterator<? extends Map.Entry<?, ?>> entries = map.entrySet().iterator();
            while (entries.hasNext()) {
                Map.Entry<?, ?> entry = entries.next();
                if (!(entry.getKey() instanceof String key)) {
                    throw new JsonException("JSON object keys must be strings");
                }
                writeString(key, output);
                output.append(':');
                write(entry.getValue(), output);
                if (entries.hasNext()) {
                    output.append(',');
                }
            }
            output.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            output.append('[');
            Iterator<?> values = iterable.iterator();
            while (values.hasNext()) {
                write(values.next(), output);
                if (values.hasNext()) {
                    output.append(',');
                }
            }
            output.append(']');
        } else if (value.getClass().isArray()) {
            output.append('[');
            int length = Array.getLength(value);
            for (int index = 0; index < length; index++) {
                if (index > 0) {
                    output.append(',');
                }
                write(Array.get(value, index), output);
            }
            output.append(']');
        } else {
            throw new JsonException("unsupported JSON value: " + value.getClass().getName());
        }
    }

    private static void writeNumber(Number number, StringBuilder output) {
        if (number instanceof Double value) {
            if (!Double.isFinite(value)) {
                throw new JsonException("JSON numbers must be finite");
            }
            output.append(value);
        } else if (number instanceof Float value) {
            if (!Float.isFinite(value)) {
                throw new JsonException("JSON numbers must be finite");
            }
            output.append(value);
        } else if (number instanceof BigDecimal decimal) {
            output.append(decimal.toPlainString());
        } else if (number instanceof BigInteger integer) {
            output.append(integer);
        } else {
            output.append(number);
        }
    }

    private static void writeString(String value, StringBuilder output) {
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) {
                        output.append(String.format("\\u%04x", (int) character));
                    } else {
                        output.append(character);
                    }
                }
            }
        }
        output.append('"');
    }

    static final class JsonException extends RuntimeException {
        JsonException(String message) {
            super(message);
        }
    }

    private static final class Parser {
        private final String input;
        private int index;

        private Parser(String input) {
            this.input = input;
        }

        private Object parseValue() {
            skipWhitespace();
            if (atEnd()) {
                throw error("expected a value");
            }
            return switch (input.charAt(index)) {
                case '{' -> parseObject();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> parseNumber();
            };
        }

        private Map<String, Object> parseObject() {
            index++;
            LinkedHashMap<String, Object> result = new LinkedHashMap<>();
            skipWhitespace();
            if (consume('}')) {
                return result;
            }
            while (true) {
                skipWhitespace();
                if (atEnd() || input.charAt(index) != '"') {
                    throw error("expected an object key");
                }
                String key = parseString();
                skipWhitespace();
                require(':');
                Object value = parseValue();
                if (result.containsKey(key)) {
                    throw error("duplicate object key: " + key);
                }
                result.put(key, value);
                skipWhitespace();
                if (consume('}')) {
                    return result;
                }
                require(',');
            }
        }

        private List<Object> parseArray() {
            index++;
            ArrayList<Object> result = new ArrayList<>();
            skipWhitespace();
            if (consume(']')) {
                return result;
            }
            while (true) {
                result.add(parseValue());
                skipWhitespace();
                if (consume(']')) {
                    return result;
                }
                require(',');
            }
        }

        private String parseString() {
            require('"');
            StringBuilder result = new StringBuilder();
            while (!atEnd()) {
                char character = input.charAt(index++);
                if (character == '"') {
                    return result.toString();
                }
                if (character == '\\') {
                    if (atEnd()) {
                        throw error("unterminated escape");
                    }
                    char escaped = input.charAt(index++);
                    switch (escaped) {
                        case '"', '\\', '/' -> result.append(escaped);
                        case 'b' -> result.append('\b');
                        case 'f' -> result.append('\f');
                        case 'n' -> result.append('\n');
                        case 'r' -> result.append('\r');
                        case 't' -> result.append('\t');
                        case 'u' -> result.append(parseUnicodeEscape());
                        default -> throw error("invalid escape: \\" + escaped);
                    }
                } else {
                    if (character < 0x20) {
                        throw error("unescaped control character");
                    }
                    result.append(character);
                }
            }
            throw error("unterminated string");
        }

        private char parseUnicodeEscape() {
            if (index + 4 > input.length()) {
                throw error("incomplete unicode escape");
            }
            int value = 0;
            for (int offset = 0; offset < 4; offset++) {
                int digit = Character.digit(input.charAt(index++), 16);
                if (digit < 0) {
                    throw error("invalid unicode escape");
                }
                value = value * 16 + digit;
            }
            return (char) value;
        }

        private Object parseLiteral(String literal, Object value) {
            if (!input.startsWith(literal, index)) {
                throw error("invalid literal");
            }
            index += literal.length();
            return value;
        }

        private Number parseNumber() {
            int start = index;
            if (consume('-') && atEnd()) {
                throw error("incomplete number");
            }
            if (consume('0')) {
                if (!atEnd() && Character.isDigit(input.charAt(index))) {
                    throw error("leading zero in number");
                }
            } else {
                requireDigits();
            }
            boolean decimal = false;
            if (consume('.')) {
                decimal = true;
                requireDigits();
            }
            if (!atEnd() && (input.charAt(index) == 'e' || input.charAt(index) == 'E')) {
                decimal = true;
                index++;
                if (!atEnd() && (input.charAt(index) == '+' || input.charAt(index) == '-')) {
                    index++;
                }
                requireDigits();
            }
            String token = input.substring(start, index);
            try {
                if (!decimal) {
                    return Long.valueOf(token);
                }
                return new BigDecimal(token);
            } catch (NumberFormatException exception) {
                try {
                    return new BigDecimal(token);
                } catch (NumberFormatException ignored) {
                    throw error("invalid number");
                }
            }
        }

        private void requireDigits() {
            int start = index;
            while (!atEnd() && Character.isDigit(input.charAt(index))) {
                index++;
            }
            if (start == index) {
                throw error("expected a digit");
            }
        }

        private void require(char expected) {
            if (!consume(expected)) {
                throw error("expected '" + expected + "'");
            }
        }

        private boolean consume(char expected) {
            if (!atEnd() && input.charAt(index) == expected) {
                index++;
                return true;
            }
            return false;
        }

        private void skipWhitespace() {
            while (!atEnd()) {
                char character = input.charAt(index);
                if (character == ' ' || character == '\n' || character == '\r' || character == '\t') {
                    index++;
                } else {
                    return;
                }
            }
        }

        private boolean atEnd() {
            return index >= input.length();
        }

        private JsonException error(String message) {
            return new JsonException(message + " at character " + index);
        }
    }
}

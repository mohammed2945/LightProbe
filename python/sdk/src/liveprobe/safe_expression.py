"""Validation and evaluation for LiveProbe's portable expression AST."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TypeAlias

from .serializer import SerializerConfig

_BINARY_OPERATORS = frozenset(
    {
        "add",
        "subtract",
        "multiply",
        "divide",
        "modulo",
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "and",
        "or",
    }
)
_FORBIDDEN_SEGMENTS = frozenset({"__proto__", "prototype", "constructor"})
_MAX_SOURCE_LENGTH = 4_096
_MAX_AST_NODES = 100
_MAX_AST_DEPTH = 20
_MAX_PATH_SEGMENTS = 64
_MAX_PATH_STRING_LENGTH = 128
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_TEMPLATE_TEXT_LENGTH = 16_384

JsonScalar: TypeAlias = str | int | float | bool | None
PathSegment: TypeAlias = str | int


@dataclass(frozen=True, slots=True)
class LiteralNode:
    value: JsonScalar


@dataclass(frozen=True, slots=True)
class ReferenceNode:
    path: tuple[PathSegment, ...]


@dataclass(frozen=True, slots=True)
class UnaryNode:
    operator: str
    operand: ExpressionNode


@dataclass(frozen=True, slots=True)
class BinaryNode:
    operator: str
    left: ExpressionNode
    right: ExpressionNode


ExpressionNode: TypeAlias = LiteralNode | ReferenceNode | UnaryNode | BinaryNode


@dataclass(frozen=True, slots=True)
class CompiledExpression:
    source: str
    ast: ExpressionNode


@dataclass(frozen=True, slots=True)
class TextSegment:
    value: str


@dataclass(frozen=True, slots=True)
class ExpressionSegment:
    expression: CompiledExpression


TemplateSegment: TypeAlias = TextSegment | ExpressionSegment


@dataclass(frozen=True, slots=True)
class ExpressionResult:
    ok: bool
    value: object = None
    error: str | None = None


def _exact_keys(raw: dict[object, object], expected: frozenset[str]) -> bool:
    keys = dict.keys(raw)
    return len(raw) == len(expected) and all(
        type(key) is str and key in expected for key in keys
    )


def _scalar(value: object) -> bool:
    return (
        value is None
        or type(value) in (str, bool)
        or _number(value)
    )


def _path_segment(value: object) -> bool:
    if type(value) is str:
        return (
            0 < len(value) <= _MAX_PATH_STRING_LENGTH
            and value not in _FORBIDDEN_SEGMENTS
        )
    return (
        type(value) is int
        and 0 <= value <= _MAX_SAFE_INTEGER
    )


def _parse_node(
    raw: object,
    *,
    state: list[int],
    depth: int,
    field_name: str,
) -> ExpressionNode:
    state[0] += 1
    if state[0] > _MAX_AST_NODES:
        raise ValueError(f"{field_name}.ast exceeds {_MAX_AST_NODES} nodes")
    if depth > _MAX_AST_DEPTH:
        raise ValueError(f"{field_name}.ast exceeds depth {_MAX_AST_DEPTH}")
    if type(raw) is not dict:
        raise ValueError(f"{field_name}.ast contains an invalid node")

    node_type = dict.get(raw, "type")
    if node_type == "literal":
        if not _exact_keys(raw, frozenset({"type", "value"})):
            raise ValueError(f"{field_name}.ast contains a malformed literal")
        value = dict.get(raw, "value")
        if not _scalar(value):
            raise ValueError(
                f"{field_name}.ast literals must be finite JSON scalars"
            )
        return LiteralNode(value)

    if node_type == "reference":
        if not _exact_keys(raw, frozenset({"type", "path"})):
            raise ValueError(f"{field_name}.ast contains a malformed reference")
        path = dict.get(raw, "path")
        if (
            type(path) is not list
            or not path
            or len(path) > _MAX_PATH_SEGMENTS
            or not all(_path_segment(segment) for segment in path)
        ):
            raise ValueError(
                f"{field_name}.ast reference paths must contain 1-"
                f"{_MAX_PATH_SEGMENTS} safe fixed segments"
            )
        return ReferenceNode(tuple(path))

    if node_type == "unary":
        if not _exact_keys(raw, frozenset({"type", "operator", "operand"})):
            raise ValueError(f"{field_name}.ast contains a malformed unary node")
        operator = dict.get(raw, "operator")
        if operator not in {"not", "negate"}:
            raise ValueError(f"{field_name}.ast contains an invalid unary operator")
        assert isinstance(operator, str)
        return UnaryNode(
            operator=operator,
            operand=_parse_node(
                dict.get(raw, "operand"),
                state=state,
                depth=depth + 1,
                field_name=field_name,
            ),
        )

    if node_type == "binary":
        if not _exact_keys(
            raw, frozenset({"type", "operator", "left", "right"})
        ):
            raise ValueError(f"{field_name}.ast contains a malformed binary node")
        operator = dict.get(raw, "operator")
        if operator not in _BINARY_OPERATORS:
            raise ValueError(f"{field_name}.ast contains an invalid binary operator")
        assert isinstance(operator, str)
        return BinaryNode(
            operator=operator,
            left=_parse_node(
                dict.get(raw, "left"),
                state=state,
                depth=depth + 1,
                field_name=field_name,
            ),
            right=_parse_node(
                dict.get(raw, "right"),
                state=state,
                depth=depth + 1,
                field_name=field_name,
            ),
        )

    raise ValueError(f"{field_name}.ast contains an unsupported node type")


def parse_compiled_expression(
    raw: object, field_name: str = "expression"
) -> CompiledExpression:
    """Validate an untrusted broker expression and return an immutable form."""

    if type(raw) is not dict or not _exact_keys(
        raw, frozenset({"source", "ast"})
    ):
        raise ValueError(f"{field_name} must contain only source and ast")
    source = dict.get(raw, "source")
    if (
        type(source) is not str
        or not source
        or len(source) > _MAX_SOURCE_LENGTH
    ):
        raise ValueError(
            f"{field_name}.source must contain 1-{_MAX_SOURCE_LENGTH} characters"
        )
    return CompiledExpression(
        source=source,
        ast=_parse_node(
            dict.get(raw, "ast"),
            state=[0],
            depth=0,
            field_name=field_name,
        ),
    )


def parse_template_segments(
    raw: object, field_name: str = "templateSegments"
) -> tuple[TemplateSegment, ...]:
    if type(raw) is not list:
        raise ValueError(f"{field_name} must be an array")
    segments: list[TemplateSegment] = []
    for index, segment in enumerate(raw):
        item_name = f"{field_name}[{index}]"
        if type(segment) is not dict:
            raise ValueError(f"{item_name} must be an object")
        segment_type = dict.get(segment, "type")
        if segment_type == "text":
            if not _exact_keys(segment, frozenset({"type", "value"})):
                raise ValueError(f"{item_name} is malformed")
            value = dict.get(segment, "value")
            if type(value) is not str or len(value) > _MAX_TEMPLATE_TEXT_LENGTH:
                raise ValueError(
                    f"{item_name}.value must be at most "
                    f"{_MAX_TEMPLATE_TEXT_LENGTH} characters"
                )
            segments.append(TextSegment(value))
            continue
        if segment_type == "expression":
            if not _exact_keys(segment, frozenset({"type", "expression"})):
                raise ValueError(f"{item_name} is malformed")
            segments.append(
                ExpressionSegment(
                    parse_compiled_expression(
                        dict.get(segment, "expression"),
                        f"{item_name}.expression",
                    )
                )
            )
            continue
        raise ValueError(f"{item_name}.type is invalid")
    return tuple(segments)


def _own_dict_value(value: dict[object, object], key: str) -> object:
    for candidate in dict.keys(value):
        if type(candidate) is str and candidate == key:
            return dict.__getitem__(value, candidate)
    return _MISSING


def _sequence_index(segment: PathSegment) -> int | None:
    if type(segment) is int:
        return segment
    if (
        type(segment) is str
        and segment.isdecimal()
        and (segment == "0" or not segment.startswith("0"))
    ):
        return int(segment)
    return None


_MISSING = object()


def _safe_result(
    value: object, serializer_config: SerializerConfig
) -> ExpressionResult:
    if type(value) in (int, float) and not _number(value):
        return ExpressionResult(False, error="unsafe-number")
    if (
        type(value) is str
        and value in serializer_config.redact_values
    ):
        return ExpressionResult(False, error="redacted")
    return ExpressionResult(True, value=value)


def _resolve_path(
    root: object,
    path: tuple[PathSegment, ...],
    serializer_config: SerializerConfig,
) -> ExpressionResult:
    current = root
    for segment in path:
        if (
            type(segment) is str
            and serializer_config.redacts_key(segment)
        ):
            return ExpressionResult(False, error="redacted")
        if type(current) is dict:
            current = _own_dict_value(current, str(segment))
            if current is _MISSING:
                return ExpressionResult(False, error="missing")
            continue
        if type(current) is list:
            index = _sequence_index(segment)
            if index is None or index >= list.__len__(current):
                return ExpressionResult(False, error="missing")
            current = list.__getitem__(current, index)
            continue
        if type(current) is tuple:
            index = _sequence_index(segment)
            if index is None or index >= tuple.__len__(current):
                return ExpressionResult(False, error="missing")
            current = tuple.__getitem__(current, index)
            continue
        return ExpressionResult(False, error="missing")
    return _safe_result(current, serializer_config)


def _number(value: object) -> bool:
    if type(value) is int:
        return abs(value) <= _MAX_SAFE_INTEGER
    return (
        type(value) is float
        and math.isfinite(value)
        and (
            not value.is_integer()
            or abs(value) <= _MAX_SAFE_INTEGER
        )
    )


def _numeric_error(*values: object) -> str:
    return (
        "unsafe-number"
        if any(
            type(value) in (int, float) and not _number(value)
            for value in values
        )
        else "expected-number" if len(values) == 1 else "expected-numbers"
    )


def _same_scalar(left: object, right: object) -> bool:
    if not (_scalar(left) and _scalar(right)):
        return False
    if _number(left) and _number(right):
        return left == right
    return type(left) is type(right) and left == right


def _finite_result(value: int | float) -> ExpressionResult:
    if type(value) is float and not math.isfinite(value):
        return ExpressionResult(False, error="non-finite-result")
    if not _number(value):
        return ExpressionResult(False, error="unsafe-number")
    return ExpressionResult(True, value=value)


def _evaluate(
    node: ExpressionNode,
    root: object,
    serializer_config: SerializerConfig,
) -> ExpressionResult:
    if isinstance(node, LiteralNode):
        return _safe_result(node.value, serializer_config)
    if isinstance(node, ReferenceNode):
        return _resolve_path(root, node.path, serializer_config)
    if isinstance(node, UnaryNode):
        operand = _evaluate(node.operand, root, serializer_config)
        if not operand.ok:
            return operand
        if node.operator == "not":
            if type(operand.value) is not bool:
                return ExpressionResult(False, error="expected-boolean")
            return ExpressionResult(True, value=not operand.value)
        if not _number(operand.value):
            return ExpressionResult(
                False, error=_numeric_error(operand.value)
            )
        assert isinstance(operand.value, (int, float))
        return _finite_result(-operand.value)

    left = _evaluate(node.left, root, serializer_config)
    if not left.ok:
        return left
    if node.operator in {"and", "or"}:
        if type(left.value) is not bool:
            return ExpressionResult(False, error="expected-boolean")
        if node.operator == "and" and left.value is False:
            return ExpressionResult(True, value=False)
        if node.operator == "or" and left.value is True:
            return ExpressionResult(True, value=True)
        right = _evaluate(node.right, root, serializer_config)
        if not right.ok:
            return right
        if type(right.value) is not bool:
            return ExpressionResult(False, error="expected-boolean")
        return right

    right = _evaluate(node.right, root, serializer_config)
    if not right.ok:
        return right
    if node.operator in {"eq", "ne"}:
        if not (_scalar(left.value) and _scalar(right.value)):
            return ExpressionResult(False, error="expected-scalars")
        equal = _same_scalar(left.value, right.value)
        return ExpressionResult(
            True, value=equal if node.operator == "eq" else not equal
        )
    if node.operator in {"gt", "gte", "lt", "lte"}:
        if not (_number(left.value) and _number(right.value)):
            return ExpressionResult(
                False, error=_numeric_error(left.value, right.value)
            )
        assert isinstance(left.value, (int, float))
        assert isinstance(right.value, (int, float))
        if node.operator == "gt":
            value = left.value > right.value
        elif node.operator == "gte":
            value = left.value >= right.value
        elif node.operator == "lt":
            value = left.value < right.value
        else:
            value = left.value <= right.value
        return ExpressionResult(True, value=value)
    if (
        node.operator == "add"
        and type(left.value) is str
        and type(right.value) is str
    ):
        return _safe_result(
            left.value + right.value, serializer_config
        )
    if not (_number(left.value) and _number(right.value)):
        return ExpressionResult(
            False, error=_numeric_error(left.value, right.value)
        )
    assert isinstance(left.value, (int, float))
    assert isinstance(right.value, (int, float))
    try:
        if node.operator == "add":
            result = left.value + right.value
        elif node.operator == "subtract":
            result = left.value - right.value
        elif node.operator == "multiply":
            result = left.value * right.value
        elif node.operator == "divide":
            if right.value == 0:
                return ExpressionResult(False, error="division-by-zero")
            result = left.value / right.value
        else:
            if right.value == 0:
                return ExpressionResult(False, error="division-by-zero")
            result = math.fmod(left.value, right.value)
            if type(left.value) is int and type(right.value) is int:
                result = int(result)
    except (OverflowError, ValueError):
        return ExpressionResult(False, error="non-finite-result")
    return _finite_result(result)


def evaluate_expression(
    expression: CompiledExpression,
    root: object,
    serializer_config: SerializerConfig | None = None,
) -> ExpressionResult:
    policy = serializer_config or SerializerConfig()
    return _evaluate(expression.ast, root, policy)


def _render_value(value: object) -> str:
    if value is None:
        return "null"
    if type(value) is str:
        return value
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if type(value) is float and math.isfinite(value):
        if value == 0:
            return "0"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return str(value)
    if type(value) in (list, tuple):
        return "[array]"
    if type(value) is dict:
        return "[object]"
    return "[unavailable]"


def render_expression_template(
    segments: tuple[TemplateSegment, ...],
    root: object,
    max_length: int = 4_096,
    *,
    serializer_config: SerializerConfig | None = None,
) -> str:
    policy = serializer_config or SerializerConfig()
    rendered = ""
    for segment in segments:
        if isinstance(segment, TextSegment):
            rendered += segment.value
        else:
            result = evaluate_expression(
                segment.expression, root, policy
            )
            rendered += (
                _render_value(result.value)
                if result.ok
                else f"<expression-error:{result.error}>"
            )
        if len(rendered) >= max_length:
            return rendered[:max_length]
    return rendered

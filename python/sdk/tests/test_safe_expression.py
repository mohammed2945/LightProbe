from __future__ import annotations

import json
from pathlib import Path

import pytest

from liveprobe.safe_expression import (
    evaluate_expression,
    parse_compiled_expression,
    parse_template_segments,
    render_expression_template,
)
from liveprobe.serializer import SerializerConfig

_EVALUATOR_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "spec"
    / "fixtures"
    / "expressions"
    / "evaluator.json"
)
_SHARED_CASES = json.loads(_EVALUATOR_FIXTURE.read_text())["cases"]


def compiled(source: str, ast: dict[str, object]) -> dict[str, object]:
    return {"source": source, "ast": ast}


def literal(value: object) -> dict[str, object]:
    return {"type": "literal", "value": value}


def reference(*path: str | int) -> dict[str, object]:
    return {"type": "reference", "path": list(path)}


def binary(
    operator: str,
    left: dict[str, object],
    right: dict[str, object],
) -> dict[str, object]:
    return {
        "type": "binary",
        "operator": operator,
        "left": left,
        "right": right,
    }


@pytest.mark.parametrize(
    "case",
    _SHARED_CASES,
    ids=[case["name"] for case in _SHARED_CASES],
)
def test_shared_evaluator_fixture(case: dict[str, object]) -> None:
    expression = parse_compiled_expression(case["expression"])
    result = evaluate_expression(expression, case["root"])
    expected = case["expected"]

    assert isinstance(expected, dict)
    assert result.ok is expected["ok"]
    if result.ok:
        assert result.value == expected["value"]
        assert result.error is None
    else:
        assert result.error == expected["error"]


@pytest.mark.parametrize(
    ("operator", "left", "right", "expected"),
    [
        ("add", 7, 2, 9),
        ("subtract", 7, 2, 5),
        ("multiply", 7, 2, 14),
        ("divide", 7, 2, 3.5),
        ("modulo", -5, 2, -1),
        ("add", "live", "probe", "liveprobe"),
        ("eq", 1, 1.0, True),
        ("ne", True, 1, True),
        ("gt", 7, 2, True),
        ("gte", 7, 7, True),
        ("lt", 2, 7, True),
        ("lte", 7, 7, True),
    ],
)
def test_portable_binary_operators(
    operator: str,
    left: object,
    right: object,
    expected: object,
) -> None:
    expression = parse_compiled_expression(
        compiled("test", binary(operator, literal(left), literal(right)))
    )

    result = evaluate_expression(expression, {})

    assert result.ok
    assert result.value == expected


def test_unary_boolean_and_short_circuit_semantics_are_strict() -> None:
    negated = parse_compiled_expression(
        compiled(
            "-amount",
            {
                "type": "unary",
                "operator": "negate",
                "operand": reference("amount"),
            },
        )
    )
    inverted = parse_compiled_expression(
        compiled(
            "!active",
            {
                "type": "unary",
                "operator": "not",
                "operand": reference("active"),
            },
        )
    )
    short_and = parse_compiled_expression(
        compiled(
            "false && missing",
            binary("and", literal(False), reference("missing")),
        )
    )
    short_or = parse_compiled_expression(
        compiled(
            "true || missing",
            binary("or", literal(True), reference("missing")),
        )
    )

    assert evaluate_expression(negated, {"amount": 4}).value == -4
    assert evaluate_expression(inverted, {"active": True}).value is False
    assert evaluate_expression(short_and, {}).value is False
    assert evaluate_expression(short_or, {}).value is True
    assert evaluate_expression(inverted, {"active": 1}).error == "expected-boolean"


@pytest.mark.parametrize("operator", ["divide", "modulo"])
def test_zero_divisor_is_an_expression_error(operator: str) -> None:
    expression = parse_compiled_expression(
        compiled("bad", binary(operator, literal(1), literal(0)))
    )

    result = evaluate_expression(expression, {})

    assert not result.ok
    assert result.error == "division-by-zero"


def test_unsafe_runtime_integer_is_contained_as_an_expression_error() -> None:
    expression = parse_compiled_expression(
        compiled(
            "huge / tiny",
            binary("divide", reference("huge"), reference("tiny")),
        )
    )

    result = evaluate_expression(
        expression, {"huge": 10**1000, "tiny": 0.5}
    )

    assert not result.ok
    assert result.error == "unsafe-number"


def test_references_use_only_builtin_container_storage() -> None:
    calls = 0

    class Dangerous:
        @property
        def secret(self) -> str:
            nonlocal calls
            calls += 1
            raise AssertionError("property was invoked")

    expression = parse_compiled_expression(
        compiled("object.explosive", reference("object", "explosive"))
    )
    nested = parse_compiled_expression(
        compiled("items[0].value", reference("items", 0, "value"))
    )

    assert evaluate_expression(expression, {"object": Dangerous()}).error == "missing"
    assert evaluate_expression(nested, {"items": [{"value": 9}]}).value == 9
    assert calls == 0


def test_expression_policy_rejects_redacted_keys_and_values() -> None:
    policy = SerializerConfig.from_mapping(
        {"redactValues": ["classified-value"]}
    )
    password = parse_compiled_expression(
        compiled("password", reference("password"))
    )
    configured_value = parse_compiled_expression(
        compiled("label", reference("label"))
    )
    configured_literal = parse_compiled_expression(
        compiled('"classified-value"', literal("classified-value"))
    )
    template = parse_template_segments(
        [
            {"type": "text", "value": "password="},
            {"type": "expression", "expression": compiled(
                "password", reference("password")
            )},
            {"type": "text", "value": " label="},
            {"type": "expression", "expression": compiled(
                "label", reference("label")
            )},
        ]
    )
    variables = {
        "password": "must-not-escape",
        "label": "classified-value",
    }

    assert evaluate_expression(password, variables, policy).error == "redacted"
    assert (
        evaluate_expression(configured_value, variables, policy).error
        == "redacted"
    )
    assert (
        evaluate_expression(configured_literal, {}, policy).error
        == "redacted"
    )
    assert render_expression_template(
        template,
        variables,
        serializer_config=policy,
    ) == (
        "password=<expression-error:redacted> "
        "label=<expression-error:redacted>"
    )


@pytest.mark.parametrize(
    "raw",
    [
        compiled("call()", {"type": "call", "callee": "call"}),
        compiled("user.constructor", reference("user", "constructor")),
        compiled("bad", {"type": "literal", "value": float("inf")}),
        compiled(
            "bad",
            {
                "type": "binary",
                "operator": "assign",
                "left": reference("value"),
                "right": literal(1),
            },
        ),
        {
            "source": "value",
            "ast": reference("value"),
            "extra": "not allowed",
        },
    ],
)
def test_malformed_or_dangerous_ast_is_rejected(
    raw: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        parse_compiled_expression(raw)


def test_ast_node_depth_and_path_limits_are_enforced() -> None:
    too_many = literal(True)
    for _ in range(6):
        too_many = binary("and", too_many, too_many)

    too_deep = literal(True)
    for _ in range(21):
        too_deep = {
            "type": "unary",
            "operator": "not",
            "operand": too_deep,
        }

    with pytest.raises(ValueError, match="100 nodes"):
        parse_compiled_expression(compiled("large", too_many))
    with pytest.raises(ValueError, match="depth 20"):
        parse_compiled_expression(compiled("deep", too_deep))
    with pytest.raises(ValueError, match="1-64 safe fixed segments"):
        parse_compiled_expression(
            compiled("path", reference(*(["item"] * 65)))
        )


def test_expression_template_renders_values_and_errors_without_execution() -> None:
    segments = parse_template_segments(
        [
            {"type": "text", "value": "total="},
            {
                "type": "expression",
                "expression": compiled(
                    "price * quantity",
                    binary(
                        "multiply",
                        reference("price"),
                        reference("quantity"),
                    ),
                ),
            },
            {"type": "text", "value": " missing="},
            {
                "type": "expression",
                "expression": compiled("absent", reference("absent")),
            },
        ]
    )

    assert render_expression_template(
        segments, {"price": 4, "quantity": 3}
    ) == "total=12 missing=<expression-error:missing>"

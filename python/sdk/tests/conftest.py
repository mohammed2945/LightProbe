from __future__ import annotations

from collections.abc import Callable

import pytest


class FakeEvents:
    LINE = 1


class FakeMonitoring:
    DEBUGGER_ID = 0
    DISABLE = object()
    events = FakeEvents()

    def __init__(self) -> None:
        self.callback: Callable[..., object] | None = None
        self.event_calls: list[int] = []
        self.restart_count = 0
        self.used = False
        self.freed = False

    def use_tool_id(self, tool_id: int, name: str) -> None:
        assert tool_id == self.DEBUGGER_ID
        assert name == "liveprobe"
        self.used = True

    def register_callback(
        self,
        tool_id: int,
        event: int,
        callback: Callable[..., object] | None,
    ) -> None:
        assert tool_id == self.DEBUGGER_ID
        assert event == self.events.LINE
        self.callback = callback

    def set_events(self, tool_id: int, events: int) -> None:
        assert tool_id == self.DEBUGGER_ID
        self.event_calls.append(events)

    def restart_events(self) -> None:
        self.restart_count += 1

    def free_tool_id(self, tool_id: int) -> None:
        assert tool_id == self.DEBUGGER_ID
        self.freed = True


@pytest.fixture
def fake_monitoring() -> FakeMonitoring:
    return FakeMonitoring()

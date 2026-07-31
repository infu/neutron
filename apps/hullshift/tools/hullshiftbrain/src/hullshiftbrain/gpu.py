"""Optional GPU experiment boundary; disabled for hard gates by design."""

from __future__ import annotations

from dataclasses import dataclass
import importlib.util


@dataclass(frozen=True, slots=True)
class GPUStatus:
    available: bool
    backend: str | None
    hard_gates_enabled: bool = False


def status() -> GPUStatus:
    if importlib.util.find_spec("jax") is not None:
        return GPUStatus(True, "jax")
    if importlib.util.find_spec("cupy") is not None:
        return GPUStatus(True, "cupy")
    return GPUStatus(False, None)


def score_batch(*_args: object, **_kwargs: object) -> None:
    raise RuntimeError("GPU scoring is experimental and disabled until the 2x end-to-end benchmark gate passes")


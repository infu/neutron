"""Client for the production TypeScript JSON-lines mechanics oracle."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
from typing import Any

from .schema import Direction, Level, PuzzleState, state_to_json


ORACLE_PROTOCOL_VERSION = 1
MAX_ORACLE_LINE_BYTES = 512 * 1024


class TypeScriptOracle:
    def __init__(self, script: Path | None = None) -> None:
        bun = shutil.which("bun")
        if bun is None:
            raise RuntimeError("bun is required for TypeScript parity checks")
        script = script or Path(__file__).resolve().parents[4] / "scripts" / "differential_brain_rules.ts"
        self._process = subprocess.Popen(
            [bun, str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._counter = 0

    def close(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            self._process.wait(timeout=5)

    def __enter__(self) -> TypeScriptOracle:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._counter += 1
        request_id = str(self._counter)
        payload = {"protocol": ORACLE_PROTOCOL_VERSION, "id": request_id, **payload}
        encoded = json.dumps(payload, separators=(",", ":")) + "\n"
        if len(encoded.encode()) > MAX_ORACLE_LINE_BYTES:
            raise ValueError("TypeScript oracle request exceeds the 512 KiB limit")
        assert self._process.stdin is not None and self._process.stdout is not None
        self._process.stdin.write(encoded)
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            error = self._process.stderr.read() if self._process.stderr is not None else ""
            raise RuntimeError("TypeScript oracle exited: " + error)
        response = json.loads(line)
        if response.get("protocol") != ORACLE_PROTOCOL_VERSION:
            raise RuntimeError("TypeScript oracle protocol mismatch")
        if response.get("id") != request_id:
            raise RuntimeError("TypeScript oracle response id mismatch")
        if not response.get("ok"):
            raise RuntimeError(str(response.get("result", {}).get("error", "oracle failure")))
        return response["result"]

    @property
    def request_count(self) -> int:
        return self._counter

    def initial(self, level: Level) -> dict[str, Any]:
        return self.request({"type": "initial", "level": level.to_json()})

    def level_hash(self, level: Level) -> str:
        return str(self.request({"type": "level-hash", "level": level.to_json()})["levelHash"])

    def transition(self, level: Level, state: PuzzleState, action: Direction) -> dict[str, Any]:
        return self.request({
            "type": "transition",
            "level": level.to_json(),
            "state": state_to_json(state),
            "action": action,
        })

#!/usr/bin/env python3
"""Extract the visible user/model conversation after a selected user message.

AI Studio exports contain internal thought chunks and structured metadata. This
script writes only non-empty text from user/model chunks, omitting thought
chunks and all JSON/tool metadata from the transcript output.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


DEFAULT_MARKER = (
    "i wa.t fou.dry space template to be so easy that even a non tenchnical "
    "domian expect"
)


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def chunks_from(document: Any) -> list[dict[str, Any]]:
    try:
        chunks = document["chunkedPrompt"]["chunks"]
    except (KeyError, TypeError) as exc:
        raise ValueError("Expected an AI Studio export with chunkedPrompt.chunks") from exc
    if not isinstance(chunks, list):
        raise ValueError("chunkedPrompt.chunks must be a list")
    return chunks


def extract(chunks: list[dict[str, Any]], marker: str) -> list[tuple[str, str, str]]:
    needle = normalize(marker)
    start = next(
        (
            i
            for i, chunk in enumerate(chunks)
            if chunk.get("role") == "user"
            and isinstance(chunk.get("text"), str)
            and needle in normalize(chunk["text"])
        ),
        None,
    )
    if start is None:
        raise ValueError(f"Could not find the requested starting user message: {marker!r}")

    messages: list[tuple[str, str, str]] = []
    for chunk in chunks[start:]:
        role = chunk.get("role")
        text = chunk.get("text")
        if role not in ("user", "model") or not isinstance(text, str) or not text.strip():
            continue
        if chunk.get("isThought") is True:
            continue
        timestamp = str(chunk.get("createTime", "")).strip()
        messages.append((role, timestamp, text.strip()))
    return messages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="AI Studio JSON export")
    parser.add_argument(
        "destination",
        type=Path,
        help="Plain-text transcript output path",
    )
    parser.add_argument(
        "--start-marker",
        default=DEFAULT_MARKER,
        help="Unique text from the user message where extraction begins",
    )
    args = parser.parse_args()

    try:
        document = json.loads(args.source.read_text(encoding="utf-8"))
        messages = extract(chunks_from(document), args.start_marker)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"extract_ai_studio_messages: {exc}", file=sys.stderr)
        return 2

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    with args.destination.open("w", encoding="utf-8", newline="\n") as output:
        for index, (role, timestamp, text) in enumerate(messages):
            if index:
                output.write("\n\n")
            label = "USER" if role == "user" else "AI MODEL"
            output.write(f"[{label}]")
            if timestamp:
                output.write(f" [{timestamp}]")
            output.write("\n")
            output.write(text)
    print(f"Wrote {len(messages)} visible messages to {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

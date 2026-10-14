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


def last_transcript_timestamp(transcript: str) -> str:
    timestamps = re.findall(r"^\[(?:USER|AI MODEL)\]\s+\[([^]]+)\]\s*$", transcript, re.MULTILINE)
    if not timestamps:
        raise ValueError("Prior transcript contains no timestamped USER or AI MODEL messages")
    return timestamps[-1]


def extract(
    chunks: list[dict[str, Any]], marker: str | None = None, after_timestamp: str | None = None
) -> list[tuple[str, str, str]]:
    if (marker is None) == (after_timestamp is None):
        raise ValueError("Specify exactly one of marker or after_timestamp")

    if after_timestamp is not None:
        boundary = next(
            (i for i, chunk in enumerate(chunks) if chunk.get("createTime") == after_timestamp),
            None,
        )
        if boundary is None:
            raise ValueError(f"Could not find prior transcript's last message timestamp: {after_timestamp!r}")
        start = boundary + 1
    else:
        assert marker is not None
        needle = normalize(marker)
        boundary = next(
            (
                i
                for i, chunk in enumerate(chunks)
                if chunk.get("role") == "user"
                and isinstance(chunk.get("text"), str)
                and needle in normalize(chunk["text"])
            ),
            None,
        )
        if boundary is None:
            raise ValueError(f"Could not find the requested starting user message: {marker!r}")
        start = boundary

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
    resume = parser.add_mutually_exclusive_group()
    resume.add_argument(
        "--start-marker",
        help="Unique text from the user message where extraction begins",
    )
    resume.add_argument(
        "--after-transcript",
        type=Path,
        help="Resume strictly after the last timestamped message in an earlier clean transcript",
    )
    args = parser.parse_args()

    try:
        document = json.loads(args.source.read_text(encoding="utf-8"))
        if args.after_transcript:
            previous = args.after_transcript.read_text(encoding="utf-8")
            messages = extract(chunks_from(document), after_timestamp=last_transcript_timestamp(previous))
        else:
            messages = extract(chunks_from(document), marker=args.start_marker or DEFAULT_MARKER)
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

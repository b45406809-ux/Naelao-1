#!/usr/bin/env python3
"""Generate docs/SPEC_HEADER_INDEX.md — a flat list of every h1/h2/h3 header in the
original spec, so we can read the index instead of grepping the 68k-line HTML."""
import re, html as ht, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "naelao_expanded_gaps_resolved.html").read_text()
heads = [(m.start(), m.group(1), re.sub('<[^>]+>', '', m.group(2)).strip())
         for m in re.finditer(r'<(h[123])[^>]*>(.*?)</\1>', html, re.S)]
indent = {"h1": "", "h2": "  ", "h3": "    "}
lines = ["# Original Spec — Header Index (auto-generated)", "",
         f"Source: naelao_expanded_gaps_resolved.html · {len(heads)} headers.",
         "Regenerate: `python3 infra/gen-spec-index.py`.",
         "Read THIS file instead of grepping the 68k-line spec. Numbers are byte offsets.", ""]
for off, tag, text in heads:
    lines.append(f"{indent[tag]}- [{off}] {ht.unescape(text)[:140]}")
(root / "docs" / "SPEC_HEADER_INDEX.md").write_text("\n".join(lines) + "\n")
print(f"wrote docs/SPEC_HEADER_INDEX.md with {len(heads)} headers")

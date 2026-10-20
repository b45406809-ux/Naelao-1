from pathlib import Path
import re, subprocess

root = Path.cwd()
paths = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
paths = sorted(p for p in paths if p)
extensions = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".sql", ".sh", ".yaml", ".yml", ".toml", ".json", ".jsonc"}
source_paths = [p for p in paths if Path(p).suffix.lower() in extensions]

# Refresh the file tree from tracked source only, deliberately excluding temporary work artifacts.
lines = [
    "Naelao repository tree",
    f"Root: {root}",
    "Inventory source: git ls-files (tracked files only)",
    f"Files: {len(paths)}",
    f"Files with source or executable-configuration extensions: {len(source_paths)}",
    "Inventory revision: 2026-10-20 audit refresh at b7f907f6",
    "Ignored dependencies, caches, generated build output, and .git internals are excluded.",
    "Empty directories are not represented because Git does not track them.",
    "",
]
file_set = set(paths)
dir_set = set()
for p in paths:
    parent = Path(p).parent
    while str(parent) != ".":
        dir_set.add(parent.as_posix())
        parent = parent.parent

def emit(parent: str, depth: int):
    prefix = parent + "/" if parent else ""
    dirs = sorted(d for d in dir_set if Path(d).parent.as_posix() == (parent or "."))
    files = sorted(p for p in file_set if Path(p).parent.as_posix() == (parent or "."))
    entries = sorted([(Path(d).name, True, d) for d in dirs] + [(Path(p).name, False, p) for p in files], key=lambda x: x[0].casefold())
    for name, is_dir, path in entries:
        lines.append("  " * depth + name + ("/" if is_dir else ""))
        if is_dir:
            emit(path, depth + 1)

emit("", 0)
(root / "audit-output/naelao-repository-tree.txt").write_text("\n".join(lines) + "\n")

plan_path = root / "audit-output/naelao-file-by-file-stress-audit-plan.md"
old_plan = plan_path.read_text()
prefix, tail = old_plan.split("## File-by-file checklist", 1)
checked = set(re.findall(r"- \[x\] `([^`]+)`", tail))
try:
    caveats = "## Audit caveats" + tail.split("## Audit caveats", 1)[1]
except IndexError:
    caveats = ""
prefix = re.sub(r"Inventory basis: .*", f"Inventory basis: `{len(paths)}` tracked files; `{len(source_paths)}` files with source or executable-configuration extensions, matching `naelao-repository-tree.txt` at code commit `b7f907f6`.", prefix)
sections = ["## File-by-file checklist", "", "Check each file only after its behavior and runtime relationships are traced and recorded. Config, schema, and deployment files are included because they affect runtime behavior and security.", ""]
groups = {}
for p in source_paths:
    parent = Path(p).parent.as_posix()
    label = "(repository root)" if parent == "." else parent
    groups.setdefault(label, []).append(p)
for group in sorted(groups, key=lambda x: (x != "(repository root)", x.casefold())):
    sections.extend([f"### `{group}`", ""])
    for p in sorted(groups[group]):
        mark = "x" if p in checked else " "
        sections.append(f"- [{mark}] `{p}`")
    sections.append("")
plan_path.write_text(prefix + "\n".join(sections) + ("\n" + caveats if caveats else ""))
print(f"refreshed tracked tree: {len(paths)} files; source checklist: {len(source_paths)} files; preserved checked rows: {len(checked)}")

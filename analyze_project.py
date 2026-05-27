import ast
import json
import argparse
import sys
import random
from pathlib import Path


_PRIMITIVE_TYPES = [
    "int", "float", "str", "bool", "bytes", "None",
]

_GENERIC_TYPES = [
    "list[int]", "list[str]", "list[float]", "list[bool]",
    "dict[str, int]", "dict[str, str]", "dict[str, Any]",
    "tuple[int, ...]", "tuple[str, int]",
    "set[str]", "set[int]",
    "Optional[str]", "Optional[int]", "Optional[float]",
    "Union[str, int]", "Union[int, None]",
    "Callable[..., None]", "Callable[[int], str]",
    "Iterator[str]", "Generator[int, None, None]",
    "Sequence[str]", "Mapping[str, Any]",
    "Any",
]

_CLASS_TYPES = [
    "Path", "TextIO", "BinaryIO", "BytesIO", "StringIO",
    "datetime", "timedelta", "UUID", "Enum",
    "BaseModel", "DataClass", "TypedDict",
    "Logger", "Session", "Connection", "Cursor",
    "Thread", "Queue", "Event", "Lock",
    "Response", "Request", "HttpClient",
    "DataFrame", "Series", "ndarray",
]

_ALL_TYPES = _PRIMITIVE_TYPES + _GENERIC_TYPES + _CLASS_TYPES


def _random_type() -> str:
    return random.choice(_ALL_TYPES)


def _random_location(rel_paths: list[str]) -> str:
    path = random.choice(rel_paths)
    line = random.randint(1, 200)
    col = random.randint(0, 40)
    return f"{path}:{line}:{col}"


class ScopeVisitor(ast.NodeVisitor):
    def __init__(self, rel_paths: list[str]):
        self.entries: dict[str, dict] = {}
        self._scope_stack: list[str] = []
        self._rel_paths = rel_paths

    @property
    def _scope(self) -> str:
        return ".".join(self._scope_stack)

    def _record(self, line: int, col: int, identifier: str, node_type: str, params: list[str] | None = None) -> None:
        entry = {"scope": self._scope, "identifier": identifier, "node_type": node_type}

        if node_type != "Class":
            entry["type"] = _random_type()

        if node_type not in ("Function", "Class", "Parameter"):
            entry["goto"] = _random_location(self._rel_paths)

        if node_type == "Function":
            entry["params"] = {p: _random_type() for p in (params or [])}
            n_callsites = random.randint(1, 4)
            entry["callsites"] = {
                _random_location(self._rel_paths): {p: _random_type() for p in (params or [])}
                for _ in range(n_callsites)
            }

        self.entries[f"{line}:{col}"] = entry

    def visit_Name(self, node: ast.Name) -> None:
        self._record(node.lineno, node.col_offset, node.id, "Name")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Attribute):
            self._record(
                node.func.end_lineno,
                node.func.end_col_offset - len(node.func.attr),
                node.func.attr,
                "Call",
            )
            self.visit(node.func.value)
        elif isinstance(node.func, ast.Name):
            self._record(node.func.lineno, node.func.col_offset, node.func.id, "Call")
        else:
            self.visit(node.func)

        for arg in node.args:
            self.visit(arg)
        for kw in node.keywords:
            self.visit(kw.value)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self._record(node.end_lineno, node.end_col_offset - len(node.attr), node.attr, "Name")
        if isinstance(node.value, ast.Call):
            self.visit_Call(node.value)
        else:
            self.visit(node.value)

    def visit_arg(self, node: ast.arg) -> None:
        self._record(node.lineno, node.col_offset, node.arg, "Parameter")
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            name = alias.asname if alias.asname else alias.name.split(".")[0]
            self._record(alias.lineno, alias.col_offset, name, "Name")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            parts = node.module.split(".")
            col = 5
            for part in parts:
                self._record(node.lineno, col, part, "Name")
                col += len(part) + 1

        for alias in node.names:
            name = alias.asname if alias.asname else alias.name
            self._record(alias.lineno, alias.col_offset, name, "Name")
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        all_args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        if node.args.vararg:
            all_args.append(node.args.vararg)
        if node.args.kwarg:
            all_args.append(node.args.kwarg)
        params = [a.arg for a in all_args]
        self._record(node.lineno, node.col_offset + 4, node.name, "Function", params=params)
        self._scope_stack.append(f"F:{node.name}")
        self.generic_visit(node)
        self._scope_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._record(node.lineno, node.col_offset + 6, node.name, "Class")
        self._scope_stack.append(f"C:{node.name}")
        self.generic_visit(node)
        self._scope_stack.pop()


def analyze_file(py_path: Path, rel_paths: list[str]) -> dict:
    tree = ast.parse(py_path.read_text(encoding="utf-8"), filename=str(py_path))
    visitor = ScopeVisitor(rel_paths)
    visitor.visit(tree)
    return dict(sorted(visitor.entries.items(), key=lambda kv: tuple(int(x) for x in kv[0].split(":"))))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    random.seed(0)

    input_dir = args.input_dir.resolve()
    output_dir = args.output_dir.resolve()

    if not input_dir.is_dir():
        sys.exit(f"Error: '{input_dir}' is not a directory.")

    py_files = sorted(input_dir.glob("**/*.py"))
    if not py_files:
        return
    output_dir.mkdir(parents=True, exist_ok=True)

    rel_paths = [str(p.relative_to(input_dir)) for p in py_files]

    pad = len(str(len(py_files) - 1))
    index: dict[str, str] = {}
    for i, py_path in enumerate(py_files):
        rel = py_path.relative_to(input_dir)
        out_name = f"{i:0{pad}}.json"
        out_path = output_dir / out_name
        try:
            out_path.write_text(
                json.dumps(analyze_file(py_path, rel_paths), indent="\t", ensure_ascii=False),
                encoding="utf-8",
            )
            index[str(rel)] = out_name
        except (SyntaxError, Exception):
            pass

    (output_dir / "index.json").write_text(
        json.dumps(index, indent="\t", ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
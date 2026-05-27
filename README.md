# Visual Studio Code Extension for Typify

A VS Code extension for **Typify**, a lightweight usage-driven static analyzer for precise Python type inference.

Typify infers types for variables, function parameters, and return values in unannotated Python codebases using symbolic execution, fixpoint analysis, and cross-module dependency resolution with no training data or existing annotations required.

Published at the *34th IEEE/ACM International Conference on Program Comprehension (ICPC 2026)*, Rio de Janeiro, Brazil.

The extension integrates the Typify backend directly into VS Code, providing interactive type information, annotation tooling, and type-aware editor assistance powered by whole-project static analysis.

## Features

* **Hover information** - inferred type signatures on hover, including per-call-site parameter and return types
* **Auto-complete** - type-aware completions drawn from the analysis cache
* **Inline annotation** - click *✎ Annotate* on any hover card to write the inferred type directly into your source
* **Sidebar panel** - configure the inference engine (context retrieval, Type4Py, top-K) without leaving VS Code
* **Status indicator** - live analyzer status in the status bar and sidebar

## Requirements

* Python 3.11+
* The extension manages its own virtual environment and installs the Typify backend automatically on first activation

## Getting Started

Open a Python project folder in VS Code. Typify will automatically analyze the workspace and populate inferred type information as you work.

The backend produces structured inference data for every analyzed source file, including resolved identifier types and a project-wide index used by the extension for hover information, completions, and inline annotations.

---

*More details to follow very soon.*

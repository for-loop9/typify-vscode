/**
 * annotator.js
 *
 * Writes inferred type annotations back into a Python source file.
 * Called by the typify.annotate command.
 *
 * Supported node_types:
 *   Function   → inserts / replaces return annotation  (`) -> Type`)
 *   Parameter  → inserts / replaces parameter annotation (`: Type`)
 *   Name       → inserts / replaces variable annotation (`: Type` on assignment LHS)
 *
 * If the existing annotation already matches the inferred type, nothing changes.
 */

const vscode = require('vscode');
const { bestType } = require('./hoverProvider');

/**
 * Determine the annotation text to insert for an entry.
 * Returns null if there's nothing useful to annotate.
 */
function resolveType(entry) {
    if (entry.node_type === 'Function') {
        return bestType(entry.type) || null;
    }
    return bestType(entry.type) || null;
}

/**
 * Main entry: annotate the symbol described by `entry` in `document`.
 * `position` is the hover position (used to locate the right AST node).
 */
async function annotateEntry(entry, document, position) {
    const inferredType = resolveType(entry);
    if (!inferredType) {
        vscode.window.showInformationMessage(
            `Typify: No type could be inferred for '${entry.identifier}'.`
        );
        return;
    }

    const text = document.getText();
    const lines = text.split('\n');

    try {
        const edit = new vscode.WorkspaceEdit();

        if (entry.node_type === 'Function') {
            await annotateFunctionReturn(entry, inferredType, document, lines, edit);
        } else if (entry.node_type === 'Parameter') {
            await annotateParameter(entry, inferredType, document, lines, edit);
        } else if (entry.node_type === 'Name' && entry.annotatable) {
            await annotateVariable(entry, inferredType, document, lines, edit);
        } else {
            vscode.window.showInformationMessage(
                `Typify: '${entry.identifier}' (${entry.node_type}) is not annotatable.`
            );
            return;
        }

        if (edit.size === 0) {
            // Either already annotated with same type or nothing to do
            return;
        }

        await vscode.workspace.applyEdit(edit);
    } catch (err) {
        vscode.window.showErrorMessage(`Typify: Annotation failed — ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function return annotation
// Finds the `)` that closes the parameter list and inserts/replaces ` -> Type`
// ─────────────────────────────────────────────────────────────────────────────

async function annotateFunctionReturn(entry, inferredType, document, lines, edit) {
    // Find the `def` line — the function entry col is offset 4 past `def `
    // so the actual `def` keyword starts at col 0 (or indented).
    // We search forward from the entry position for the `:` that ends the def header.

    const entryLine = position1BasedToIndex(entry) ?? 0;
    const defLine = findDefLine(lines, entry.identifier, entryLine);
    if (defLine === -1) return;

    // Scan from defLine forward to find the closing `)` of the param list,
    // then look for an existing `->` annotation before the final `:`
    const { closeParen, arrowStart, arrowEnd, colonPos } = parseDefHeader(lines, defLine);
    if (closeParen === null) return;

    if (arrowStart !== null) {
        // There's already a return annotation — check if it matches
        const existing = lines[arrowEnd.line]
            .slice(arrowStart.col, arrowEnd.col)
            .trim()
            .replace(/^->\s*/, '');
        if (existing === inferredType) return; // same — do nothing
        // Replace existing annotation
        const range = new vscode.Range(
            new vscode.Position(arrowStart.line, arrowStart.col),
            new vscode.Position(arrowEnd.line, arrowEnd.col),
        );
        edit.replace(document.uri, range, `-> ${inferredType} `);
    } else {
        // Insert after closing paren
        const insertPos = new vscode.Position(closeParen.line, closeParen.col + 1);
        edit.insert(document.uri, insertPos, ` -> ${inferredType}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter annotation
// Inserts/replaces `: Type` after the parameter name in the signature.
// ─────────────────────────────────────────────────────────────────────────────

async function annotateParameter(entry, inferredType, document, lines, edit) {
    // entry position is 1-based line, 0-based col
    const [lineIdx, col] = entryKey(entry);
    if (lineIdx === null) return;

    const line = lines[lineIdx];
    const nameEnd = col + entry.identifier.length;

    // Check for existing annotation: `: SomeType` immediately after the name
    const afterName = line.slice(nameEnd).match(/^(\s*:\s*)([^\s,)=][^,)=]*?)(\s*[,)=]|$)/);
    if (afterName) {
        const existing = afterName[2].trim();
        if (existing === inferredType) return; // same
        // Replace from `:` up to the matched type end
        const annotStart = nameEnd + afterName[1].length - 1; // position of `:`
        const annotEnd   = nameEnd + afterName[1].length + afterName[2].length - 1;
        // We replace just the type string (leave the colon and spacing)
        const typeStart = nameEnd + afterName[1].length;
        const typeEnd   = typeStart + afterName[2].trimEnd().length;
        edit.replace(
            document.uri,
            new vscode.Range(new vscode.Position(lineIdx, typeStart), new vscode.Position(lineIdx, typeEnd)),
            inferredType
        );
    } else {
        // No annotation — insert `: Type` right after the identifier
        edit.insert(document.uri, new vscode.Position(lineIdx, nameEnd), `: ${inferredType}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable annotation
// Turns `x = ...` into `x: Type = ...`
// ─────────────────────────────────────────────────────────────────────────────

async function annotateVariable(entry, inferredType, document, lines, edit) {
    const [lineIdx, col] = entryKey(entry);
    if (lineIdx === null) return;

    const line = lines[lineIdx];
    const nameEnd = col + entry.identifier.length;
    const after = line.slice(nameEnd);

    // Already annotated: `x: SomeType = ...`
    const annMatch = after.match(/^(\s*:\s*)([^\s=][^=]*?)(\s*=)/);
    if (annMatch) {
        const existing = annMatch[2].trim();
        if (existing === inferredType) return;
        const typeStart = nameEnd + annMatch[1].length;
        const typeEnd   = typeStart + annMatch[2].trimEnd().length;
        edit.replace(
            document.uri,
            new vscode.Range(new vscode.Position(lineIdx, typeStart), new vscode.Position(lineIdx, typeEnd)),
            inferredType
        );
        return;
    }

    // Plain assignment: `x = ...`
    const assignMatch = after.match(/^(\s*=\s*)/);
    if (assignMatch) {
        // Insert `: Type` between the name and ` =`
        const insertAt = nameEnd;
        edit.insert(document.uri, new vscode.Position(lineIdx, insertAt), `: ${inferredType}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract [0-based lineIndex, col] from an entry's position embedded in state,
 *  using the hovered position we stored. */
function entryKey(entry) {
    // We don't have the key directly on the entry object, but we can derive
    // the line/col from the entry's identifier position via the fileData keys.
    // Since annotateEntry is called with (entry, document, position), and
    // position is 0-based, we use that.
    // This is handled by the caller passing lineIdx/col via closure.
    return [null, null]; // fallback — overridden in each call path below
}

/** Find the line index (0-based) where `def <name>` appears, starting from hint. */
function findDefLine(lines, name, hintLine) {
    const re = new RegExp(`\\bdef\\s+${escapeRegex(name)}\\s*\\(`);
    for (let i = hintLine; i < Math.min(hintLine + 5, lines.length); i++) {
        if (re.test(lines[i])) return i;
    }
    // Fallback: search whole file
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) return i;
    }
    return -1;
}

/**
 * Parse a `def` header that may span multiple lines.
 * Returns:
 *   closeParen: { line, col } of the `)` closing the param list
 *   arrowStart: { line, col } of the `->` token (or null)
 *   arrowEnd:   { line, col } just past the return-type token (or null)
 *   colonPos:   { line, col } of the trailing `:`
 */
function parseDefHeader(lines, defLine) {
    let depth = 0;
    let closeParen = null;
    let arrowStart = null;
    let arrowEnd = null;
    let colonPos = null;
    let started = false;

    for (let li = defLine; li < Math.min(defLine + 20, lines.length); li++) {
        const line = lines[li];
        for (let ci = 0; ci < line.length; ci++) {
            const ch = line[ci];
            if (ch === '(' ) { depth++; started = true; }
            else if (ch === ')' && started) {
                depth--;
                if (depth === 0) closeParen = { line: li, col: ci };
            } else if (closeParen && !arrowStart) {
                // Look for `->` after close paren
                const rest = line.slice(ci);
                const m = rest.match(/^->/);
                if (m) {
                    arrowStart = { line: li, col: ci };
                    // Find the end of the type expression (up to `:`)
                    const typeRest = line.slice(ci + 2);
                    const colonIdx = typeRest.indexOf(':');
                    if (colonIdx !== -1) {
                        arrowEnd = { line: li, col: ci + 2 + colonIdx };
                        colonPos = { line: li, col: ci + 2 + colonIdx };
                    }
                    break;
                } else if (ch === ':') {
                    colonPos = { line: li, col: ci };
                    break;
                }
            }
        }
        if (colonPos) break;
    }

    return { closeParen, arrowStart, arrowEnd, colonPos };
}

function position1BasedToIndex(entry) {
    // Not directly available — callers provide lineIdx explicitly
    return null;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public annotateEntry with position plumbing fixed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Annotate `entry` in `document`. `fileData` is the full analysis map for this
 * file so we can locate the exact line:col key.
 */
async function annotate(entry, document, fileData) {
    const inferredType = resolveType(entry);
    if (!inferredType) {
        vscode.window.showInformationMessage(
            `Typify: No type could be inferred for '${entry.identifier}'.`
        );
        return;
    }

    // Find the line:col key for this entry in fileData
    let lineIdx = null, col = null;
    for (const [key, e] of Object.entries(fileData)) {
        if (e === entry) {
            [lineIdx, col] = key.split(':').map(Number);
            lineIdx -= 1; // convert to 0-based
            break;
        }
    }
    if (lineIdx === null) return;

    const text = document.getText();
    const lines = text.split('\n');
    const edit = new vscode.WorkspaceEdit();

    try {
        if (entry.node_type === 'Function') {
            const defLine = findDefLine(lines, entry.identifier, lineIdx);
            if (defLine === -1) return;
            const { closeParen, arrowStart, arrowEnd } = parseDefHeader(lines, defLine);
            if (!closeParen) return;

            if (arrowStart !== null && arrowEnd !== null) {
                // Extract existing type string between `-> ` and the `:`
                const arrowLineText = lines[arrowStart.line];
                const typeStr = arrowLineText.slice(arrowStart.col + 2, arrowEnd.col).trim();
                if (typeStr === inferredType) return; // already correct
                edit.replace(
                    document.uri,
                    new vscode.Range(
                        new vscode.Position(arrowStart.line, arrowStart.col),
                        new vscode.Position(arrowEnd.line, arrowEnd.col),
                    ),
                    `-> ${inferredType} `
                );
            } else {
                edit.insert(
                    document.uri,
                    new vscode.Position(closeParen.line, closeParen.col + 1),
                    ` -> ${inferredType}`
                );
            }

        } else if (entry.node_type === 'Parameter') {
            const line = lines[lineIdx];
            const nameEnd = col + entry.identifier.length;
            const after = line.slice(nameEnd);
            const annMatch = after.match(/^(\s*:\s*)(\S[^,)=]*?)(\s*(?:[,)=]|$))/);
            if (annMatch) {
                const existing = annMatch[2].trim();
                if (existing === inferredType) return;
                const typeStart = nameEnd + annMatch[1].length;
                const typeEnd   = typeStart + annMatch[2].trimEnd().length;
                edit.replace(
                    document.uri,
                    new vscode.Range(new vscode.Position(lineIdx, typeStart), new vscode.Position(lineIdx, typeEnd)),
                    inferredType
                );
            } else {
                edit.insert(document.uri, new vscode.Position(lineIdx, nameEnd), `: ${inferredType}`);
            }

        } else if (entry.node_type === 'Name' && entry.annotatable) {
            const line = lines[lineIdx];
            const nameEnd = col + entry.identifier.length;
            const after = line.slice(nameEnd);
            const annMatch = after.match(/^(\s*:\s*)(\S[^=]*?)(\s*=)/);
            if (annMatch) {
                const existing = annMatch[2].trim();
                if (existing === inferredType) return;
                const typeStart = nameEnd + annMatch[1].length;
                const typeEnd   = typeStart + annMatch[2].trimEnd().length;
                edit.replace(
                    document.uri,
                    new vscode.Range(new vscode.Position(lineIdx, typeStart), new vscode.Position(lineIdx, typeEnd)),
                    inferredType
                );
            } else if (after.match(/^\s*=/)) {
                edit.insert(document.uri, new vscode.Position(lineIdx, nameEnd), `: ${inferredType}`);
            }
        } else {
            vscode.window.showInformationMessage(
                `Typify: '${entry.identifier}' (${entry.node_type}) cannot be annotated.`
            );
            return;
        }

        if (edit.size > 0) {
            await vscode.workspace.applyEdit(edit);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Typify: Annotation failed — ${err.message}`);
    }
}

module.exports = { annotate };
const vscode = require('vscode');
const path = require('path');
const { getAnalysisCache, getIndex } = require('./state');

// The most recently hovered entry - read by the typify.annotate command.
let _lastHoveredEntry = null;
let _lastHoveredDocument = null;

function getLastHovered() {
    return { entry: _lastHoveredEntry, document: _lastHoveredDocument };
}

function bestType(typeObj) {
    if (!typeObj || typeof typeObj !== 'object') return 'Any';

    const usage = typeObj.usage ?? '';

    // If usage exists, return it immediately
    if (usage) return usage;

    const retrieved = typeObj.retrieved ?? {};
    const type4py   = typeObj.type4py ?? {};

    const retrievedEntries = Object.entries(retrieved)
        .map(([t, m]) => ({ t, v: (m.score ?? 0) * Math.sqrt(m.hits ?? 1) }))
        .sort((a, b) => b.v - a.v);

    const type4pyEntries = Object.entries(type4py)
        .map(([t, m]) => ({ t, v: m.score ?? 0 }))
        .sort((a, b) => b.v - a.v);

    const topR = retrievedEntries[0];
    const topT = type4pyEntries[0];

    if (topR && topR.v > 0.3) return topR.t;
    if (topT && topT.v > 0.4) return topT.t;
    if (topR) return topR.t;
    if (topT) return topT.t;

    return 'Any';
}

function getFileData(document, workspacePath) {
    if (!getIndex()) return null;
    const relPath = path.relative(workspacePath, document.uri.fsPath).replace(/\\/g, '/');
    return getAnalysisCache(relPath);
}

function findEntry(fileData, position, wordRange) {
    if (!fileData) return null;
    
    const line = position.line + 1;
    const colStart = wordRange.start.character;
    
    for (const [key, entry] of Object.entries(fileData)) {
        const [entryLine, entryCol] = key.split(':').map(Number);
        if (entryLine === line && colStart === entryCol) {
            return entry
        }
    }
    return null
}

function formatFunctionSignature(name, params, returnTypeObj, kind = 'def') {
    const ret     = bestType(returnTypeObj) || 'None';
    const entries = Object.entries(params);

    if (entries.length === 0) {
        return `${kind} ${name}() -> ${ret}`;
    }
    if (entries.length === 1) {
        const [[p, tObj]] = entries;
        return `${kind} ${name}(${p}: ${bestType(tObj) || '?'}) -> ${ret}`;
    }

    const paramLines = entries
        .map(([p, tObj], i) => `    ${p}: ${bestType(tObj) || '?'}${i < entries.length - 1 ? ',' : ''}`)
        .join('\n');
    return `${kind} ${name}(\n${paramLines}\n) -> ${ret}`;
}

function formatFunctionSignatureForCallSites(name, params, returnTypeObj) {
    const ret     = bestType(returnTypeObj) || '?';
    const entries = Object.entries(params);

    if (entries.length === 0) {
        return `${name}() -> ${ret}`;
    }
    if (entries.length === 1) {
        const [[p, tObj]] = entries;
        return `${name}(${p}: ${bestType(tObj) || '?'}) -> ${ret}`;
    }

    const paramLines = entries
        .map(([p, tObj], i) => `\t\t${p}: ${bestType(tObj) || '?'}${i < entries.length - 1 ? ',' : ''}`)
        .join('\n');
    return `\t${name}(\n${paramLines}\n\t) -> ${ret}`;
}

function buildHoverContent(entry) {
    const code = new vscode.MarkdownString();
    code.isTrusted    = true;
    code.supportHtml  = true;

    // ── Header ──────────────────────────────────────────────────────────────
    code.appendMarkdown(
        '<span style="' +
            'font-size:10px;font-weight:700;letter-spacing:.8px;' +
            'text-transform:uppercase;opacity:.55;' +
        '">Typify</span>\n\n---\n\n'
    );
    if (entry.node_type === 'Function') {
        code.appendCodeblock(
            formatFunctionSignature(entry.identifier, entry.params ?? {}, entry.type),
            'python'
        );
    } else if (entry.node_type === 'Class') {
        code.appendCodeblock(`(class) ${entry.identifier}`, 'python');
    } else if (entry.node_type === 'Parameter') {
        code.appendCodeblock(
            `(param) ${entry.identifier}: ${bestType(entry.type) || 'Any'}`,
            'python'
        );
    } else {
        code.appendCodeblock(
            `(${entry.node_type.toLowerCase()}) ${entry.identifier}: ${bestType(entry.type) || 'Any'}`,
            'python'
        );
    }

    // ── Annotate button — only for annotatable entries ──────────────────────
    if (entry.annotatable) {
        const annotateCmd = vscode.Uri.parse(
            `command:typify.annotate?${encodeURIComponent(JSON.stringify({ identifier: entry.identifier }))}`
        );
        const btnStyle = [
            'display:inline-block',
            'margin-left:8px',
            'padding:1px 8px',
            'border-radius:3px',
            'font-size:11px',
            'font-weight:600',
            'text-decoration:none',
            'cursor:pointer',
            'vertical-align:middle',
            'background:var(--vscode-button-background,#0e639c)',
            'color:var(--vscode-button-foreground,#fff)',
            'border:1px solid var(--vscode-button-border,transparent)',
        ].join(';');
        code.appendMarkdown(`<a href="${annotateCmd}" style="${btnStyle}">✎ Annotate</a>`);
    }

    if (entry.scope) {
        code.appendMarkdown(`\n\n*Scope:* \`${entry.scope || '(module)'}\``);
    }

    if (entry.goto) {
        code.appendMarkdown(`\n\n*Defined at:* \`${entry.goto}\``);
    }

    if (entry.node_type === 'Function' && entry.callsites) {
        const sites = Object.entries(entry.callsites);
        if (sites.length > 0) {
            code.appendMarkdown(`\n\n*Called from ${sites.length} location(s):*`);
            for (const [site, info] of sites) {
                // site format: "relative/path.py:line:col" — show only filename:line
                const parts = site.split(':');
                const lineNum = parts.length >= 2 ? parts[parts.length - 1] : null;
                const filePath = parts.slice(0, parts.length - (lineNum ? 1 : 0)).join(':');
                const fileName = path.basename(filePath);
                const display = lineNum ? `${fileName}:${lineNum}` : fileName;
                code.appendMarkdown(`\n\n*at* \`${display}\``);
                code.appendCodeblock(
                    formatFunctionSignatureForCallSites(entry.identifier, info?.params ?? {}, info?.type),
                    'python'
                );
            }
        }
    }

    code.appendMarkdown('\n\n---');

    return new vscode.Hover(code);
}

class TypeHoverProvider {
    constructor(workspacePath) {
        this.workspacePath = workspacePath;
    }

    provideHover(document, position) {
        const fileData = getFileData(document, this.workspacePath);
        if (!fileData) return null;

        const wordRange = document.getWordRangeAtPosition(position, /[\w.]+/);
        if (!wordRange) return null;

        const entry = findEntry(fileData, position, wordRange);
        if (!entry) return null;

        _lastHoveredEntry    = entry;
        _lastHoveredDocument = document;

        return buildHoverContent(entry);
    }
}

module.exports = { TypeHoverProvider, getLastHovered, bestType };
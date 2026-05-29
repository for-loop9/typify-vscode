const vscode = require('vscode');
const path = require('path');
const { getAnalysisCache, getIndex, getAllAnalysis } = require('./state');
const { bestType } = require('./hoverProvider');

function itemsFromFileData(fileData) {
    const seen = new Set();
    const items = [];

    for (const entry of Object.values(fileData)) {
        const key = `${entry.node_type}:${entry.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let kind;
        switch (entry.node_type) {
            case 'Function': kind = vscode.CompletionItemKind.Function; break;
            case 'Class':    kind = vscode.CompletionItemKind.Class;    break;
            case 'Parameter':kind = vscode.CompletionItemKind.Variable; break;
            default:         kind = vscode.CompletionItemKind.Field;    break;
        }

        const item = new vscode.CompletionItem(entry.identifier, kind);

        if (entry.node_type === 'Function') {
            const params = Object.entries(entry.params ?? {})
                .map(([n, tObj]) => `${n}: ${bestType(tObj) || '?'}`)
                .join(', ');
            const ret = bestType(entry.type) || 'None';
            item.detail = `(${ret}) ${entry.identifier}(${params})`;

            const snippetParams = Object.keys(entry.params ?? {})
                .map((n, i) => `\${${i + 1}:${n}}`)
                .join(', ');
            item.insertText = new vscode.SnippetString(`${entry.identifier}(${snippetParams})$0`);
        } else if (entry.node_type === 'Class') {
            item.detail = `(class) ${entry.identifier}`;
        } else {
            const t = bestType(entry.type);
            item.detail = t ? `${entry.identifier}: ${t}` : entry.identifier;
        }

        const docs = new vscode.MarkdownString();
        // docs.appendMarkdown('**TYPIFY**\n\n---\n\n');
        docs.appendMarkdown(
        '<span style="' +
            'font-size:10px;font-weight:700;letter-spacing:.8px;' +
            'text-transform:uppercase;opacity:.55;' +
        '">Typify</span>\n\n---\n\n'
    );
        docs.appendCodeblock(item.detail, 'python');
        if (entry.scope) docs.appendMarkdown(`\n*Scope:* \`${entry.scope}\``);
        if (entry.goto)  docs.appendMarkdown(`\n\n*Defined at:* \`${entry.goto}\``);
        item.documentation = docs;

        item.sortText = entry.node_type === 'Function' ? `0_${entry.identifier}`
            : entry.node_type === 'Class'              ? `1_${entry.identifier}`
            : `2_${entry.identifier}`;

        items.push(item);
    }

    return items;
}

class TypeCompletionProvider {
    constructor(workspacePath) {
        this.workspacePath = workspacePath;
    }

    provideCompletionItems(document, position) {
        if (!getIndex()) return [];

        const relPath = path.relative(this.workspacePath, document.uri.fsPath).replace(/\\/g, '/');
        const allAnalysis = getAllAnalysis();
        const items = [];

        for (const [filePath, fileData] of Object.entries(allAnalysis)) {
            const isCurrentFile = filePath === relPath;
            const fileItems = itemsFromFileData(fileData);

            if (!isCurrentFile) {
                const moduleItems = fileItems.filter(item => {
                    const entry = Object.values(fileData).find(e => e.identifier === item.label);
                    return entry && (!entry.scope || entry.scope === '');
                });
                items.push(...moduleItems);
            } else {
                items.push(...fileItems);
            }
        }

        return items;
    }
}

module.exports = { TypeCompletionProvider };
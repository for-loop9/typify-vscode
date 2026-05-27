const vscode = require('vscode');
const path = require('path');
const { runAnalyzer } = require('./analyzer');
const { getStatus, onStateChange } = require('./state');
const { TypeHoverProvider, getLastHovered } = require('./hoverProvider');
const { TypeCompletionProvider } = require('./completionProvider');
const { SidebarProvider, VIEW_TYPE } = require('./sidebarProvider');
const { annotate } = require('./annotator');

// ─────────────────────────────────────────────
// Status-bar item
// ─────────────────────────────────────────────

function createStatusBarItem() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.command = 'typify.showSidebar';
    return item;
}

const STATUS_BAR_STATE = {
    idle:    { text: '$(circle-outline) Typify', color: undefined },
    running: { text: '$(sync~spin) Typify',      color: new vscode.ThemeColor('statusBarItem.warningBackground') },
    ready:   { text: '$(pass) Typify',            color: new vscode.ThemeColor('statusBarItem.prominentBackground') },
    error:   { text: '$(error) Typify',           color: new vscode.ThemeColor('statusBarItem.errorBackground') },
};

function updateStatusBar(item) {
    const { status, statusMessage } = getStatus();
    const cfg = STATUS_BAR_STATE[status] ?? STATUS_BAR_STATE.idle;
    item.text = cfg.text;
    item.backgroundColor = cfg.color;
    item.tooltip = statusMessage ? `Typify — ${statusMessage}` : 'Typify — click to open panel';
    item.show();
}

// ─────────────────────────────────────────────
// Activate
// ─────────────────────────────────────────────

function activate(context) {

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Typify: No workspace open.');
        return;
    }
    const projectPath = workspaceFolder.uri.fsPath;

    // ── Status bar ──────────────────────────────
    const statusBar = createStatusBarItem();
    context.subscriptions.push(statusBar);
    onStateChange(() => updateStatusBar(statusBar));
    updateStatusBar(statusBar);

    // ── Sidebar ─────────────────────────────────
    const sidebarProvider = new SidebarProvider(context, projectPath);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_TYPE, sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // ── File watcher & debounced re-analysis ────
    let timeout;
    function debouncedRun() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            runAnalyzer(context, projectPath).catch(err => {
                console.error('Typify analyzer error:', err);
            });
        }, 1000);
    }

    // Give the sidebar a callback so saving config triggers re-analysis
    sidebarProvider.setReanalyzeCallback(() => debouncedRun());

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
    watcher.onDidChange(() => debouncedRun());
    watcher.onDidCreate(() => debouncedRun());
    watcher.onDidDelete(() => debouncedRun());
    context.subscriptions.push(watcher);

    // ── Hover provider ──────────────────────────
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { scheme: 'file', language: 'python' },
            new TypeHoverProvider(projectPath)
        )
    );

    // ── Completion provider ─────────────────────
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', language: 'python' },
            new TypeCompletionProvider(projectPath),
            '.',
        )
    );

    // ── Commands ────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('typify.showSidebar', () => {
            vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('typify.reanalyze', () => {
            runAnalyzer(context, projectPath).catch(err => {
                vscode.window.showErrorMessage(`Typify: ${err.message}`);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('typify.annotate', async () => {
            const { entry, context: hoverCtx } = getLastHovered();
            if (!entry) return;

            if (!entry.annotatable) {
                vscode.window.showInformationMessage(
                    `Typify: '${entry.identifier}' is not annotatable.`
                );
                return;
            }

            const document = hoverCtx?.document
                ?? vscode.window.activeTextEditor?.document;
            if (!document) return;

            // Retrieve the file data so annotate() can locate the entry key
            const { getAnalysisCache } = require('./state');
            const relPath = path.relative(projectPath, document.uri.fsPath).replace(/\\/g, '/');
            const fileData = getAnalysisCache(relPath);
            if (!fileData) return;

            await annotate(entry, document, fileData);
        })
    );

    // ── Initial run ─────────────────────────────
    runAnalyzer(context, projectPath).catch(err => {
        console.error('Typify initial analysis failed:', err);
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
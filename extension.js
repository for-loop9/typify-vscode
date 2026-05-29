const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runAnalyzer } = require('./analyzer');
const { getStatus, onStateChange, getPaused } = require('./state');
const { TypeHoverProvider, getLastHovered } = require('./hoverProvider');
const { TypeCompletionProvider } = require('./completionProvider');
const { SidebarProvider, VIEW_TYPE } = require('./sidebarProvider');
const { annotate } = require('./annotator');

// ─────────────────────────────────────────────────────────────────────────────
// Mirror helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh temp directory to use as the mirror for this session.
 * Returns the absolute path to the mirror root.
 */
function createMirrorDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'typify-mirror-'));
}

/**
 * Copy every .py file from `projectPath` into `mirrorPath`, preserving the
 * relative directory structure.  Existing mirror files are overwritten.
 * config.json is intentionally not copied — it is created and owned by typify.
 */
function seedMirror(projectPath, mirrorPath) {
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Skip hidden dirs (e.g. .git, .typify)
                if (!entry.name.startsWith('.')) walk(abs);
            } else if (entry.isFile() && entry.name.endsWith('.py')) {
                const rel  = path.relative(projectPath, abs);
                const dest = path.join(mirrorPath, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(abs, dest);
            }
        }
    };
    walk(projectPath);
}

/**
 * Write `text` to the mirror copy of `fsPath`.
 * Creates parent directories as needed.
 */
function flushToMirror(projectPath, mirrorPath, fsPath, text) {
    const rel  = path.relative(projectPath, fsPath);
    const dest = path.join(mirrorPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
}

/**
 * Remove a file from the mirror (e.g. when deleted from the workspace).
 * Silently ignores missing files.
 */
function removeFromMirror(projectPath, mirrorPath, fsPath) {
    const rel  = path.relative(projectPath, fsPath);
    const dest = path.join(mirrorPath, rel);
    try { fs.unlinkSync(dest); } catch (_) { /* already gone */ }
}

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

    // ── Mirror setup ────────────────────────────
    // One temp dir per session; seeded with all .py files from the workspace.
    // All subsequent analysis runs against this mirror so unsaved edits are
    // picked up without requiring a file save.
    const mirrorPath = createMirrorDir();
    seedMirror(projectPath, mirrorPath);

    // Clean up the mirror when the extension is deactivated.
    context.subscriptions.push({
        dispose() {
            try { fs.rmSync(mirrorPath, { recursive: true, force: true }); } catch (_) {}
        }
    });

    // ── Status bar ──────────────────────────────
    const statusBar = createStatusBarItem();
    context.subscriptions.push(statusBar);
    onStateChange(() => updateStatusBar(statusBar));
    updateStatusBar(statusBar);

    // ── Sidebar ─────────────────────────────────
    const sidebarProvider = new SidebarProvider(context, projectPath, mirrorPath);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_TYPE, sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // ── Debounced re-analysis ───────────────────
    let timeout;
    function debouncedRun() {
        if (getPaused()) return;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            if (getPaused()) return;
            runAnalyzer(context, projectPath, mirrorPath).catch(err => {
                console.error('Typify analyzer error:', err);
            });
        }, 1000);
    }

    // Give the sidebar a callback so saving config triggers re-analysis
    sidebarProvider.setReanalyzeCallback(() => debouncedRun());

    // ── In-memory change listener ───────────────
    // Fires on every keystroke (no save required).  We flush the current
    // document text to the mirror and kick a debounced analysis run.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const doc = event.document;
            if (doc.languageId !== 'python') return;
            if (!doc.uri.fsPath.startsWith(projectPath)) return;

            flushToMirror(projectPath, mirrorPath, doc.uri.fsPath, doc.getText());
            debouncedRun();
        })
    );

    // ── File-system watcher ─────────────────────
    // Handles on-disk events: new files created outside the editor, and
    // deletions.  Saves are already handled by onDidChangeTextDocument above,
    // but onDidChange here acts as a fallback for external editors.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
    watcher.onDidChange(uri => {
        // Only sync if the document isn't open (open docs are covered above)
        const isOpen = vscode.workspace.textDocuments
            .some(d => d.uri.fsPath === uri.fsPath);
        if (!isOpen) {
            try {
                flushToMirror(projectPath, mirrorPath, uri.fsPath,
                    fs.readFileSync(uri.fsPath, 'utf8'));
            } catch (_) {}
        }
        debouncedRun();
    });
    watcher.onDidCreate(uri => {
        try {
            flushToMirror(projectPath, mirrorPath, uri.fsPath,
                fs.readFileSync(uri.fsPath, 'utf8'));
        } catch (_) {}
        debouncedRun();
    });
    watcher.onDidDelete(uri => {
        removeFromMirror(projectPath, mirrorPath, uri.fsPath);
        debouncedRun();
    });
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
            runAnalyzer(context, projectPath, mirrorPath).catch(err => {
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
    runAnalyzer(context, projectPath, mirrorPath).catch(err => {
        console.error('Typify initial analysis failed:', err);
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
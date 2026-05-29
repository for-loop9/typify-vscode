const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getStatus, onStateChange, getPaused, setPaused } = require('./state');

const VIEW_TYPE = 'typify.sidebar';

class SidebarProvider {
    /** @param {vscode.ExtensionContext} context @param {string} projectPath @param {string} mirrorPath */
    constructor(context, projectPath, mirrorPath) {
        this._context = context;
        this._projectPath = projectPath;
        this._mirrorPath = mirrorPath;
        this._view = null;
        this._onReanalyze = null; // set by extension.js

        onStateChange(() => this._push());
    }

    /** Called by extension.js so the sidebar can trigger re-analysis on config change. */
    setReanalyzeCallback(fn) { this._onReanalyze = fn; }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html();

        webviewView.webview.onDidReceiveMessage(async msg => {
            switch (msg.type) {
                case 'ready':
                    // Webview just loaded — send current state
                    this._push();
                    break;

                case 'saveConfig': {
                    const ok = this._writeConfig(msg.config);
                    if (ok && this._onReanalyze) {
                        // Re-run analysis with new config
                        this._onReanalyze();
                    }
                    break;
                }

                case 'togglePause': {
                    setPaused(msg.paused);
                    // If resuming, trigger a fresh analysis run
                    if (!msg.paused && this._onReanalyze) {
                        this._onReanalyze();
                    }
                    this._push();
                    break;
                }
            }
        });

        this._push();
    }

    // ── Config helpers ──────────────────────────────────────────────────────

    /**
     * The config.json is created and owned by typify — we never create it.
     * We only read it (to populate the sidebar) and patch it (on save).
     */
    _configPath() {
        return path.join(this._mirrorPath, '.typify', 'config.json');
    }

    _readConfig() {
        const p = this._configPath();
        if (!fs.existsSync(p)) return null; // not yet created by typify
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (_) { return null; }
    }

    _writeConfig(patch) {
        try {
            const p = this._configPath();
            if (!fs.existsSync(p)) return false; // typify hasn't run yet
            const current = JSON.parse(fs.readFileSync(p, 'utf8'));
            fs.writeFileSync(p, JSON.stringify({ ...current, ...patch }, null, '\t'), 'utf8');
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`Typify: Could not save config — ${err.message}`);
            return false;
        }
    }

    // ── State push ──────────────────────────────────────────────────────────

    _push() {
        if (!this._view) return;
        const { status, statusMessage } = getStatus();
        const config = this._readConfig();
        const paused = getPaused();
        this._view.webview.postMessage({ type: 'stateUpdate', status, statusMessage, config, paused });
    }

    // ── Webview HTML ────────────────────────────────────────────────────────

    _html() {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Typify</title>
<style>
  :root {
    --radius: 6px;
    --gap: 14px;
    --font:      var(--vscode-font-family, 'Segoe UI', sans-serif);
    --font-mono: var(--vscode-editor-font-family, monospace);
    --bg:        var(--vscode-sideBar-background, #1e1e1e);
    --surface:   var(--vscode-editor-background, #252526);
    --border:    var(--vscode-panel-border, #333);
    --fg:        var(--vscode-foreground, #ccc);
    --fg-dim:    var(--vscode-descriptionForeground, #888);
    --accent:    var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --input-bg:  var(--vscode-input-background, #3c3c3c);
    --input-fg:  var(--vscode-input-foreground, #ccc);
    --input-border: var(--vscode-input-border, #555);
    --toggle-on: var(--vscode-statusBarItem-prominentBackground, #388bfd);
    --err:       var(--vscode-statusBarItem-errorBackground, #c72e0f);
    --warn:      var(--vscode-editorWarning-foreground, #cca700);
    --ok:        var(--vscode-testing-iconPassed, #4db46c);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font); font-size: 13px; color: var(--fg);
    background: var(--bg); padding: var(--gap);
    display: flex; flex-direction: column; gap: var(--gap); min-height: 100vh;
  }

  /* Header */
  .header { display:flex; align-items:center; gap:8px; padding-bottom:var(--gap); border-bottom:1px solid var(--border); }
  .header-title { font-weight:600; font-size:13px; letter-spacing:.4px; text-transform:uppercase; }
  .header-sub { font-size:10px; color:var(--fg-dim); font-weight:400; }

  /* Card */
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:12px; display:flex; flex-direction:column; gap:10px; }
  .card-label { font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:var(--fg-dim); font-weight:600; }

  /* Status */
  .status-row { display:flex; align-items:center; gap:8px; }
  .status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; background:var(--fg-dim); transition:background .3s; }
  .status-dot.running { background:var(--warn); animation:pulse 1s ease-in-out infinite; }
  .status-dot.ready   { background:var(--ok); }
  .status-dot.error   { background:var(--err); }
  .status-dot.idle    { background:var(--fg-dim); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .status-text   { font-size:12px; color:var(--fg); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .status-detail { font-size:11px; color:var(--fg-dim); font-family:var(--font-mono); word-break:break-all; line-height:1.5; }

  /* Toggle row */
  .toggle-row { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
  .toggle-info { display:flex; flex-direction:column; gap:3px; flex:1; }
  .toggle-title { font-size:12px; font-weight:500; color:var(--fg); }
  .toggle-desc  { font-size:11px; color:var(--fg-dim); line-height:1.4; }
  .switch { position:relative; width:36px; height:20px; flex-shrink:0; margin-top:1px; }
  .switch input { display:none; }
  .track { position:absolute; inset:0; border-radius:20px; background:var(--border); cursor:pointer; transition:background .2s; }
  .track::after { content:''; position:absolute; left:3px; top:3px; width:14px; height:14px; border-radius:50%; background:var(--fg-dim); transition:transform .2s, background .2s; }
  .switch input:checked + .track { background:var(--toggle-on); }
  .switch input:checked + .track::after { transform:translateX(16px); background:#fff; }

  /* Text / number input row */
  .field-row { display:flex; flex-direction:column; gap:4px; }
  .field-label { font-size:11px; color:var(--fg-dim); }
  .field-input {
    background:var(--input-bg); color:var(--input-fg);
    border:1px solid var(--input-border); border-radius:3px;
    padding:4px 7px; font-size:12px; font-family:var(--font-mono);
    width:100%; outline:none;
  }
  .field-input:focus { border-color:var(--accent); }
  input[type=number].field-input { width:72px; }

  /* Save button */
  .save-btn {
    display:flex; align-items:center; justify-content:center; gap:6px;
    padding:5px 12px; border-radius:3px; font-size:12px; font-weight:600;
    border:none; cursor:pointer;
    background:var(--accent); color:var(--accent-fg);
    transition:opacity .15s;
  }
  .save-btn:hover { opacity:.85; }
  .save-btn:disabled { opacity:.45; cursor:default; }

  /* Inline pause button (inside status card) */
  .pause-btn {
    display:flex; align-items:center; gap:4px;
    padding:2px 8px; border-radius:3px; font-size:10px; font-weight:600;
    border:1px solid var(--border); cursor:pointer;
    background:transparent; color:var(--fg-dim);
    transition:background .15s, color .15s, border-color .15s;
    white-space:nowrap; flex-shrink:0; line-height:1.6;
  }
  .pause-btn:hover { background:var(--input-bg); color:var(--fg); }
  .pause-btn.paused { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent); }

  /* Badge */
  .badge { display:inline-flex; align-items:center; padding:1px 6px; border-radius:20px; font-size:10px; font-weight:600; text-transform:uppercase; margin-left:5px; }
  .badge.exp { background:color-mix(in srgb,var(--warn) 18%,transparent); color:var(--warn); border:1px solid color-mix(in srgb,var(--warn) 35%,transparent); }

  /* Footer */
  .footer { margin-top:auto; font-size:10px; color:var(--fg-dim); text-align:center; opacity:.6; }

  /* Divider */
  .divider { height:1px; background:var(--border); margin:2px 0; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header-title">Typify</div>
    <div class="header-sub">Usage-driven Static Analyzer</div>
  </div>
</div>

<!-- Status -->
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
    <div class="card-label" style="margin:0">Analyzer status</div>
    <button class="pause-btn" id="pauseBtn" title="Pause or resume live analysis">⏸ Pause</button>
  </div>
  <div class="status-row">
    <div class="status-dot idle" id="dot"></div>
    <div class="status-text" id="statusText">Idle</div>
  </div>
  <div class="status-detail" id="statusDetail"></div>
</div>

<!-- Config -->
<div class="card" id="configCard" style="display:none">
  <div class="card-label">Configuration</div>

  <!-- Context Retrieval toggle -->
  <div class="toggle-row">
    <div class="toggle-info">
      <div class="toggle-title">Context Retrieval</div>
      <div class="toggle-desc">Use retrieval-augmented inference for better type coverage.</div>
    </div>
    <label class="switch"><input type="checkbox" id="cfgRetrieval"><div class="track"></div></label>
  </div>

  <!-- Augment context toggle -->
  <div class="toggle-row">
    <div class="toggle-info">
      <div class="toggle-title">Augment Context <span class="badge exp">experimental</span></div>
      <div class="toggle-desc">Enrich retrieval context with additional metadata.</div>
    </div>
    <label class="switch"><input type="checkbox" id="cfgAugment"><div class="track"></div></label>
  </div>

  <!-- Type4Py toggle -->
  <div class="toggle-row">
    <div class="toggle-info">
      <div class="toggle-title">Type4Py Neural Model</div>
      <div class="toggle-desc">Enhance inference with the Type4Py deep-learning model.</div>
    </div>
    <label class="switch"><input type="checkbox" id="cfgType4py"><div class="track"></div></label>
  </div>

  <!-- Type4Py API URL (shown only when type4py is on) -->
  <div class="field-row" id="apiUrlRow">
    <div class="field-label">Type4Py API URL</div>
    <input id="cfgApiUrl" type="text" class="field-input" placeholder="https://…">
  </div>

  <div class="divider"></div>

  <!-- Save -->
  <button class="save-btn" id="saveBtn" disabled>Save &amp; Re-analyze</button>
</div>

<div class="footer">Typify · usage-driven static analysis</div>

<script>
  const vscode = acquireVsCodeApi();

  // Elements
  const dot          = document.getElementById('dot');
  const statusText   = document.getElementById('statusText');
  const statusDetail = document.getElementById('statusDetail');
  const cfgRetrieval = document.getElementById('cfgRetrieval');
  const cfgType4py   = document.getElementById('cfgType4py');
  const cfgApiUrl    = document.getElementById('cfgApiUrl');
  const cfgAugment   = document.getElementById('cfgAugment');
  const apiUrlRow    = document.getElementById('apiUrlRow');
  const saveBtn      = document.getElementById('saveBtn');
  const pauseBtn     = document.getElementById('pauseBtn');

  const STATUS_LABELS = { idle:'Idle', running:'Analyzing…', ready:'Ready', error:'Error' };

  // Track whether the user has made changes
  let _dirty = false;
  let _paused = false;

  // ── Pause toggle ────────────────────────────────────────────────────────────
  function applyPaused(paused) {
    _paused = paused;
    if (paused) {
      pauseBtn.textContent = '▶ Resume';
      pauseBtn.classList.add('paused');
    } else {
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.classList.remove('paused');
    }
  }

  pauseBtn.addEventListener('click', () => {
    const next = !_paused;
    applyPaused(next);
    vscode.postMessage({ type: 'togglePause', paused: next });
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  function markDirty() {
    _dirty = true;
    saveBtn.disabled = false;
    updateVisibility();
  }

  function updateVisibility() {
    apiUrlRow.style.display = cfgType4py.checked ? '' : 'none';
  }

  function applyConfig(config) {
    cfgRetrieval.checked = !!config['context-retrieval'];
    cfgType4py.checked   = !!config['type4py'];
    cfgApiUrl.value      = config['type4py-api-url'] ?? '';
    cfgAugment.checked   = !!config['augment-context'];
    updateVisibility();
  }

  function readConfig() {
    return {
      'context-retrieval':  cfgRetrieval.checked,
      'type4py':            cfgType4py.checked,
      'type4py-api-url':    cfgApiUrl.value.trim(),
      'augment-context':    cfgAugment.checked,
    };
  }

  // Wire up change listeners
  [cfgRetrieval, cfgType4py, cfgApiUrl, cfgAugment].forEach(el => {
    el.addEventListener('change', markDirty);
    el.addEventListener('input',  markDirty);
  });

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    _dirty = false;
    vscode.postMessage({ type: 'saveConfig', config: readConfig() });
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type !== 'stateUpdate') return;

    // Paused state
    if (typeof msg.paused === 'boolean') applyPaused(msg.paused);

    // Status
    dot.className = 'status-dot ' + (msg.paused ? 'idle' : msg.status);
    statusText.textContent   = msg.paused ? 'Paused' : (STATUS_LABELS[msg.status] ?? msg.status);
    statusDetail.textContent = msg.statusMessage ?? '';

    // Config card — only visible once analysis is complete
    const isReady = msg.status === 'ready';
    document.getElementById('configCard').style.display = isReady ? '' : 'none';

    // Config — only update if user hasn't made unsaved changes
    if (isReady && !_dirty && msg.config) {
      applyConfig(msg.config);
    }
  });

  // Tell the extension we're ready
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

module.exports = { SidebarProvider, VIEW_TYPE };
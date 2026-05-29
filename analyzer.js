const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const { setIndex, setAnalysisCache, clearAnalysisCache, setStatus } = require('./state');

// ─────────────────────────────────────────────────────────────────────────────
// Virtual-environment helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Absolute path to the venv that lives inside the extension's own directory.
 * Using the extension dir (not the workspace) means one venv per install, not
 * one per project.
 */
function venvDir(context) {
    return path.join(context.extensionPath, '.typify-venv');
}

/**
 * Path to the Python / pip executables inside the venv.
 * On Windows the layout is Scripts\; on POSIX it's bin/.
 */
function venvBin(context) {
    const base = venvDir(context);
    return process.platform === 'win32'
        ? path.join(base, 'Scripts')
        : path.join(base, 'bin');
}

function venvPython(context) {
    return path.join(venvBin(context), process.platform === 'win32' ? 'python.exe' : 'python3');
}

function venvTypify(context) {
    return path.join(venvBin(context), process.platform === 'win32' ? 'typify.exe' : 'typify');
}

/**
 * Find a usable system Python 3 (python3 → python → py -3 on Windows).
 * Returns the command string, or null if nothing is found.
 */
function findSystemPython() {
    const candidates = process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];

    for (const cmd of candidates) {
        try {
            // Quick synchronous existence check via PATH resolution
            const result = require('child_process').spawnSync(cmd, ['--version']);
            if (result.status === 0) return cmd;
        } catch (_) { /* not found */ }
    }
    return null;
}

/**
 * Ensure the venv exists and has typify-cli installed.
 * Resolves when the environment is ready; rejects with a descriptive error
 * if Python can't be found or pip fails.
 *
 * Safe to call on every activation — it short-circuits if the binary already
 * exists.
 */
function ensureVenv(context) {
    const typifyBin = venvTypify(context);

    // Fast path: already installed
    if (fs.existsSync(typifyBin)) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const systemPython = findSystemPython();
        if (!systemPython) {
            return reject(new Error(
                'Typify: Python 3 was not found on PATH. ' +
                'Please install Python 3.8+ and reload VS Code.'
            ));
        }

        const venv = venvDir(context);
        setStatus('running', 'Setting up Typify environment…');

        // Step 1 — create the venv
        const create = spawn(systemPython, ['-m', 'venv', venv]);

        create.stderr.on('data', d => console.error('[typify venv create]', d.toString()));

        create.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`Failed to create venv (exit ${code}). Is the venv module available?`));
            }

            setStatus('running', 'Installing typify-cli…');

            // Step 2 — pip install typify-cli into the venv
            const pip = spawn(venvPython(context), [
                '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
                'typify-cli',
            ]);

            pip.stderr.on('data', d => console.error('[typify pip]', d.toString()));
            pip.stdout.on('data', d => console.log('[typify pip]', d.toString()));

            pip.on('close', pipCode => {
                if (pipCode !== 0) {
                    return reject(new Error(`pip install typify-cli failed (exit ${pipCode}).`));
                }
                resolve();
            });

            pip.on('error', reject);
        });

        create.on('error', reject);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} context  - VS Code extension context
 * @param {string} projectPath - real workspace root (used for relative-path keys)
 * @param {string} [mirrorPath] - temp mirror to analyse instead of projectPath;
 *                                when omitted the real workspace is used directly
 */
function runAnalyzer(context, projectPath, mirrorPath) {

    setStatus('running', 'Analyzing project…');

    const analysisRoot = mirrorPath ?? projectPath;
    const outputDir    = path.join(analysisRoot, '.typify');
    const indexPath    = path.join(outputDir, 'index.json');

    return ensureVenv(context)
        .then(() => new Promise((resolve, reject) => {

            setStatus('running', 'Analyzing project…');

            const proc = spawn(venvTypify(context), ["infer", analysisRoot, outputDir]);

            proc.stdout.on('data', data => console.log('[typify]', data.toString()));
            proc.stderr.on('data', data => console.error('[typify]', data.toString()));

            proc.on('error', err => {
                setStatus('error', `Failed to launch typify-cli: ${err.message}`);
                reject(err);
            });

            proc.on('close', code => {

                if (code !== 0) {
                    const msg = `typify-cli exited with code ${code}`;
                    setStatus('error', msg);
                    return reject(new Error(msg));
                }

                try {
                    if (!fs.existsSync(indexPath)) {
                        setStatus('ready', 'No Python files found');
                        return resolve();
                    }

                    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
                    setIndex(index);

                    // Load per-file analysis into the cache
                    clearAnalysisCache();
                    for (const [relPath, jsonFile] of Object.entries(index)) {
                        const jsonPath = path.join(outputDir, jsonFile);
                        if (!fs.existsSync(jsonPath)) continue;
                        try {
                            const fileData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                            setAnalysisCache(relPath, fileData);
                        } catch (_) { /* skip unparseable files */ }
                    }

                    setStatus('ready', 'Analysis complete');

                } catch (err) {
                    setStatus('error', err.message);
                    reject(err);
                    return;
                }

                resolve();
            });
        }));
}

module.exports = { runAnalyzer };
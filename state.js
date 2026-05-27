let cachedIndex = null;

// Status: 'idle' | 'running' | 'error' | 'ready'
let status = 'idle';
let statusMessage = '';

// { [relPath]: analysisData }
let analysisCache = {};

const _listeners = new Set();

function _notify() {
    for (const fn of _listeners) fn();
}

function onStateChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function setIndex(data) {
    cachedIndex = data;
    _notify();
}

function getIndex() {
    return cachedIndex;
}

function setAnalysisCache(relPath, data) {
    analysisCache[relPath] = data;
}

function getAnalysisCache(relPath) {
    return analysisCache[relPath] ?? null;
}

function getAllAnalysis() {
    return analysisCache;
}

function clearAnalysisCache() {
    analysisCache = {};
}

function setStatus(s, message = '') {
    status = s;
    statusMessage = message;
    _notify();
}

function getStatus() {
    return { status, statusMessage };
}

module.exports = {
    setIndex,
    getIndex,
    setAnalysisCache,
    getAnalysisCache,
    getAllAnalysis,
    clearAnalysisCache,
    setStatus,
    getStatus,
    onStateChange,
};
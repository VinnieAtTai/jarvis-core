// Local speech-to-text bridge for the JARVIS console.
//
// The default STT path is the browser's webkitSpeechRecognition (Google cloud). This module is
// the OPTIONAL local path Chris can switch to for offline / privacy-sensitive sessions: the
// console captures one utterance of mic audio as a 16 kHz mono WAV and POSTs it to the hub's
// /stt, which calls transcribe() here. We keep a whisper.cpp `whisper-server` child process warm
// (model loaded once) and forward each utterance to its /inference endpoint. Audio never leaves
// the machine.
//
// The binary + model live OUTSIDE the repo by default (%LOCALAPPDATA%\jarvis\stt) so a
// `git clean -x` in the source tree can't wipe the (hundreds-of-MB) model download, matching the
// hub's runtime-state placement. Override any of these with env vars:
//   JARVIS_STT_DIR    - folder holding the binary + model (default %LOCALAPPDATA%\jarvis\stt)
//   JARVIS_WHISPER_BIN   - full path to whisper-server(.exe)
//   JARVIS_WHISPER_MODEL - full path to a ggml-*.bin model
//   JARVIS_STT_PORT   - port for the local whisper server (default 8125)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

const STT_DIR = process.env.JARVIS_STT_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis', 'stt') : join(process.cwd(), 'stt'));
const PORT = Number(process.env.JARVIS_STT_PORT || 8125);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BIN_NAME = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';

let child = null;        // the whisper-server process, or null
let ready = false;       // server is up and answering
let starting = null;     // in-flight ensureReady() promise, so concurrent callers share one boot

// Resolve the whisper-server binary: explicit env override, else the first known server exe name
// present under <STT_DIR> (or its bin/ subfolder). whisper.cpp releases have shipped both
// `whisper-server(.exe)` and a bare `server(.exe)`, so we probe both rather than hard-coding one.
function binPath() {
    if (process.env.JARVIS_WHISPER_BIN) return process.env.JARVIS_WHISPER_BIN;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const names = ['whisper-server' + suffix, 'server' + suffix];
    // The prebuilt Windows zip extracts into a Release/ subfolder (exe + its DLLs together);
    // probe it as well as the flat layout so either install shape works without flattening.
    for (const dir of [STT_DIR, join(STT_DIR, 'bin'), join(STT_DIR, 'Release')]) {
        for (const n of names) { const p = join(dir, n); if (existsSync(p)) return p; }
    }
    return join(STT_DIR, BIN_NAME);   // canonical default (for the "not found" error message)
}
// Resolve the model: explicit env override, else the first ggml-*.bin under <STT_DIR> (or its
// models/ subfolder). Prefer the smallest .en model found so boot is fast when several exist.
function modelPath() {
    if (process.env.JARVIS_WHISPER_MODEL) return process.env.JARVIS_WHISPER_MODEL;
    for (const dir of [STT_DIR, join(STT_DIR, 'models')]) {
        let names;
        try { names = readdirSync(dir); } catch { continue; }
        const models = names.filter(n => /^ggml-.*\.bin$/i.test(n))
            .map(n => ({ n, path: join(dir, n), size: (() => { try { return statSync(join(dir, n)).size; } catch { return Infinity; } })() }))
            .sort((a, b) => a.size - b.size);
        if (models.length) return models[0].path;
    }
    return join(STT_DIR, 'model.bin');
}

export function isReady() { return ready && !!child; }
export function backendDir() { return STT_DIR; }

// Bring the local whisper server up (idempotent). Throws a human-actionable error if the binary
// or model isn't installed yet — that message is surfaced to Chris so he knows what to download.
export function ensureReady() {
    if (isReady()) return Promise.resolve();
    if (starting) return starting;
    const bin = binPath(), model = modelPath();
    if (!existsSync(bin)) return Promise.reject(new Error('whisper-server not found at ' + bin + ' (install it under ' + STT_DIR + ')'));
    if (!existsSync(model)) return Promise.reject(new Error('no ggml model found under ' + STT_DIR + ' (download e.g. ggml-base.en.bin)'));
    starting = new Promise((resolve, reject) => {
        const threads = Math.max(2, ((cpus().length || 4) - 1));
        child = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT),
            '-t', String(threads), '-l', 'en', '--no-timestamps'], { stdio: 'ignore', windowsHide: true });
        child.on('exit', () => { child = null; ready = false; });
        child.on('error', (e) => { child = null; ready = false; if (starting) reject(e); });
        // Poll until the server accepts requests (model load can take a few seconds on CPU).
        const deadline = Date.now() + 45000;
        (async function waitUp() {
            while (Date.now() < deadline) {
                // Process died while we were waiting (crash, bad model, missing DLL). The 'error'
                // handler already rejects a spawn failure, but a start-then-exit fires only 'exit'
                // (which nulls child) — so reject here too, or ensureReady() would hang forever and
                // wedge every future /stt call on the same unsettled promise.
                if (!child) return reject(new Error('whisper-server exited during startup (check the model + DLLs under ' + STT_DIR + ')'));
                try {
                    const r = await fetch(ORIGIN + '/', { method: 'GET' });
                    if (r.status) { ready = true; return resolve(); }
                } catch { /* not up yet */ }
                await sleep(400);
            }
            reject(new Error('whisper-server did not come up within 45s'));
        })();
    }).finally(() => { starting = null; });
    return starting;
}

export function stop() {
    ready = false;
    if (child) { try { child.kill(); } catch { } child = null; }
}

// Transcribe one utterance (a WAV buffer) via the warm whisper server; returns the text.
export async function transcribe(wavBuffer) {
    await ensureReady();
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utt.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    const r = await fetch(ORIGIN + '/inference', { method: 'POST', body: form });
    if (!r.ok) throw new Error('whisper-server /inference ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        const j = await r.json();
        return cleanText(j.text || j.transcription || '');
    }
    return cleanText(await r.text());
}

// whisper emits leading/trailing spaces and the odd bracketed non-speech marker ([BLANK_AUDIO],
// (silence), etc.) — strip those so a silent utterance yields '' rather than noise.
export function cleanText(t) {
    return String(t || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\((?:silence|no speech|blank[^)]*)\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

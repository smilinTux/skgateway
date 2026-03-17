/**
 * file.mjs — File-Based JSONL Audit Output for SKGateway SIEM
 *
 * Responsibilities
 * ────────────────
 * 1. JSONL Writing  — serialise events as newline-delimited JSON, one per line.
 * 2. Log Rotation   — rotate the active file once it exceeds `rotate_mb` (default
 *                     100 MB).  Rotated files are renamed with a UTC timestamp
 *                     suffix; old files beyond `keep_files` (default 10) are
 *                     deleted automatically.
 * 3. Batch Flushing — accumulate writes and flush to disk every `flush_ms`
 *                     (default 1000 ms) or every `flush_batch` events
 *                     (default 100), whichever comes first.
 * 4. PGP Signing    — placeholder hook (`_signRotated(path)`) called after each
 *                     rotation.  Implement signing logic there; the stub currently
 *                     just logs a notice.
 * 5. Async Safety   — all disk I/O is async; concurrent calls are serialised
 *                     internally so the event bus never races file operations.
 *
 * Usage
 * ─────
 *   import { createFileOutput } from './siem/file.mjs';
 *
 *   const out = createFileOutput({
 *     path:        './logs/audit.jsonl',
 *     rotate_mb:   100,
 *     keep_files:  10,
 *     flush_ms:    1000,
 *     flush_batch: 100,
 *   });
 *
 *   // Register with the event bus:
 *   bus.addOutput(out);
 *
 *   // Or call directly:
 *   out.write(event);
 *   await out.flush();   // force flush
 *   await out.close();   // flush + close fd
 *
 * @module siem/file
 */

import {
  open,
  stat,
  rename,
  unlink,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

// ─── constants ────────────────────────────────────────────────────────────────

const DEFAULT_ROTATE_MB   = 100;
const DEFAULT_KEEP_FILES  = 10;
const DEFAULT_FLUSH_MS    = 1_000;
const DEFAULT_FLUSH_BATCH = 100;

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a Date as a compact UTC timestamp suitable for file suffixes.
 * e.g. `20260317T142500Z`
 *
 * @param {Date} [d=new Date()]
 * @returns {string}
 */
function utcStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Derive the rotated filename from the active log path and a timestamp.
 * e.g. `./logs/audit.jsonl` → `./logs/audit.20260317T142500Z.jsonl`
 *
 * @param {string} activePath
 * @param {string} stamp
 * @returns {string}
 */
function rotatedPath(activePath, stamp) {
  const dir  = dirname(activePath);
  const base = basename(activePath);        // "audit.jsonl"
  const dot  = base.lastIndexOf('.');
  if (dot < 1) return join(dir, `${base}.${stamp}`);
  return join(dir, `${base.slice(0, dot)}.${stamp}${base.slice(dot)}`);
}

/**
 * List rotated archive files in the same directory, sorted oldest-first.
 * Matches filenames like `{stem}.{20-char timestamp}.{ext}`.
 *
 * @param {string} activePath  Active log file path (used to derive stem+ext).
 * @returns {Promise<string[]>}  Absolute paths, oldest first.
 */
async function listRotated(activePath) {
  const dir  = dirname(activePath);
  const base = basename(activePath);
  const dot  = base.lastIndexOf('.');
  const stem = dot < 1 ? base          : base.slice(0, dot);
  const ext  = dot < 1 ? ''            : base.slice(dot);        // ".jsonl"

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // Match: stem + '.' + 16-char UTC stamp + ext
  // e.g.  audit.20260317T142500Z.jsonl
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
    `\\.\\d{8}T\\d{6}Z` +
    `${ext.replace(/\./g, '\\.')}$`,
  );

  return entries
    .filter(e => pattern.test(e))
    .sort()                             // lexicographic = chronological
    .map(e => join(dir, e));
}

// ─── PGP signing placeholder ──────────────────────────────────────────────────

/**
 * PGP signing hook — called after a log file is rotated and closed.
 *
 * TODO: Implement actual PGP signing when the SKSecurity module exposes
 * a programmatic signing API.  Suggested approach:
 *   1. Import `signFile` from `~/clawd/skcapstone-repos/SKSecurity/sign.mjs`.
 *   2. Call `await signFile(path, { detach: true, keyId: agentKeyId })`.
 *   3. This produces `${path}.asc` alongside the rotated archive.
 *   4. Store key ID in `config.pgp_key_id`.
 *
 * @param {string} path  Absolute path to the just-rotated (closed) log file.
 * @returns {Promise<void>}
 */
async function _signRotated(path) {
  // Placeholder — log the hook point without failing the rotation pipeline.
  process.stderr.write(
    `[skgateway:siem:file] PGP signing hook (not yet implemented): ${path}\n`,
  );
  // Future: await signFile(path, { detach: true });
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FileOutputConfig
 * @property {string}  path          - Absolute or relative path to the active log file.
 * @property {number}  [rotate_mb]   - Rotate when file exceeds this size in megabytes. Default 100.
 * @property {number}  [keep_files]  - Number of rotated archives to retain. Default 10.
 * @property {number}  [flush_ms]    - Max milliseconds between automatic flushes. Default 1000.
 * @property {number}  [flush_batch] - Flush early when the buffer reaches this many events. Default 100.
 * @property {boolean} [enabled]     - Set false to create a no-op output. Default true.
 */

/**
 * @typedef {object} FileOutput
 * @property {(event: object) => void}  write  Buffer one event for async write.
 * @property {() => Promise<void>}      flush  Force-flush the buffer to disk now.
 * @property {() => Promise<void>}      close  Flush, close the file handle, clear timers.
 */

/**
 * Create a file-based JSONL audit output adapter.
 *
 * The returned object is compatible with the EventBus `OutputAdapter` interface
 * and can also be used standalone.
 *
 * @param {FileOutputConfig} config
 * @returns {FileOutput}
 */
export function createFileOutput(config) {
  const {
    path:        logPath,
    rotate_mb:   rotateBytes = DEFAULT_ROTATE_MB * 1024 * 1024,
    keep_files:  keepFiles   = DEFAULT_KEEP_FILES,
    flush_ms:    flushMs     = DEFAULT_FLUSH_MS,
    flush_batch: flushBatch  = DEFAULT_FLUSH_BATCH,
    enabled                  = true,
  } = config ?? {};

  // Normalise: if rotate_mb was passed as megabytes, convert to bytes
  const rotateBytesNorm = rotateBytes < 1024
    ? rotateBytes * 1024 * 1024   // caller passed MB integer (< 1024 means raw MB)
    : rotateBytes;                // caller passed bytes (from config resolution)

  // ── disabled mode ─────────────────────────────────────────────────────────
  if (!enabled || !logPath) {
    return {
      write:  () => {},
      flush:  async () => {},
      close:  async () => {},
    };
  }

  // ── state ─────────────────────────────────────────────────────────────────

  /** @type {import('node:fs/promises').FileHandle | null} */
  let _fd      = null;
  let _fdSize  = 0;        // bytes written to current fd (tracked locally)
  let _closed  = false;

  /** @type {string[]} */
  const _buffer = [];      // pending JSONL lines (not yet written to fd)

  // Serialise all async I/O on a single promise chain so rotations and writes
  // never race each other.
  let _chain = Promise.resolve();

  /** @type {ReturnType<typeof setInterval> | null} */
  let _timer = null;

  // ── file operations ───────────────────────────────────────────────────────

  /**
   * Ensure the log directory exists and open the active file for appending.
   * If the file already exists, stat it to get the current size.
   *
   * @returns {Promise<void>}
   */
  async function _openFile() {
    if (_fd) return;
    const dir = dirname(logPath);
    await mkdir(dir, { recursive: true });
    _fd = await open(logPath, 'a');                  // O_WRONLY | O_CREAT | O_APPEND
    try {
      const s = await stat(logPath);
      _fdSize = s.size;
    } catch {
      _fdSize = 0;
    }
  }

  /**
   * Close the current file handle (if open).
   * @returns {Promise<void>}
   */
  async function _closeFile() {
    if (!_fd) return;
    try { await _fd.close(); }
    catch { /* ignore close errors on shutdown */ }
    _fd = null;
  }

  /**
   * Rotate the active log file:
   *   1. Flush the write buffer to the current fd.
   *   2. Close the current fd.
   *   3. Rename the current file to a timestamped archive name.
   *   4. Call the PGP signing hook on the rotated file.
   *   5. Prune old archives beyond `keepFiles`.
   *   6. Reopen a fresh active file.
   *
   * @returns {Promise<void>}
   */
  async function _rotate() {
    process.stderr.write(`[skgateway:siem:file] rotating ${logPath}\n`);

    // Write any buffered lines before closing
    await _writeBuffer();
    await _closeFile();

    const stamp   = utcStamp();
    const archive = rotatedPath(logPath, stamp);

    try {
      await rename(logPath, archive);
    } catch (err) {
      process.stderr.write(`[skgateway:siem:file] rename failed: ${err.message}\n`);
    }

    // PGP hook — non-blocking; errors must not abort rotation
    _signRotated(archive).catch((err) => {
      process.stderr.write(`[skgateway:siem:file] sign hook error: ${err.message}\n`);
    });

    // Prune old archives
    try {
      const rotated = await listRotated(logPath);
      const excess  = rotated.length - keepFiles;
      if (excess > 0) {
        for (const old of rotated.slice(0, excess)) {
          try {
            await unlink(old);
            process.stderr.write(`[skgateway:siem:file] pruned ${old}\n`);
          } catch (e) {
            process.stderr.write(`[skgateway:siem:file] prune error for ${old}: ${e.message}\n`);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[skgateway:siem:file] prune listing error: ${err.message}\n`);
    }

    // Open a fresh active file
    _fdSize = 0;
    await _openFile();
  }

  /**
   * Write all pending lines in `_buffer` to the active file handle.
   * Rotates if the file has grown beyond the threshold.
   *
   * Must only be called from within the serialised `_chain`.
   *
   * @returns {Promise<void>}
   */
  async function _writeBuffer() {
    if (_buffer.length === 0) return;

    await _openFile();

    const chunk = _buffer.splice(0, _buffer.length).join('\n') + '\n';
    const bytes = Buffer.byteLength(chunk, 'utf8');

    await _fd.write(chunk, null, 'utf8');
    _fdSize += bytes;

    // Check rotation threshold after the write
    if (_fdSize >= rotateBytesNorm) {
      await _rotate();
    }
  }

  /**
   * Enqueue work on the serialised chain.
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  function _schedule(work) {
    _chain = _chain.then(work).catch((err) => {
      process.stderr.write(`[skgateway:siem:file] I/O error: ${err.message}\n`);
    });
    return _chain;
  }

  // ── timer ─────────────────────────────────────────────────────────────────

  function _startTimer() {
    if (_timer) return;
    _timer = setInterval(() => {
      if (_buffer.length > 0) {
        _schedule(_writeBuffer);
      }
    }, flushMs);
    _timer.unref();
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Buffer one event for async write.
   * Triggers an early flush if the batch size limit is reached.
   *
   * @param {object} event  Any serialisable event object.
   */
  function write(event) {
    if (_closed) {
      process.stderr.write('[skgateway:siem:file] WARN: write() called after close()\n');
      return;
    }

    try {
      _buffer.push(JSON.stringify(event));
    } catch (err) {
      process.stderr.write(`[skgateway:siem:file] serialise error: ${err.message}\n`);
      return;
    }

    // Start the flush timer on the first write
    _startTimer();

    // Early flush when batch is full
    if (_buffer.length >= flushBatch) {
      _schedule(_writeBuffer);
    }
  }

  /**
   * Force-flush all buffered events to disk immediately.
   * Resolves after all pending writes complete.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    if (_buffer.length === 0 && _buffer.length === 0) {
      // Nothing to flush — still wait for any in-flight writes to finish
      return _chain;
    }
    return _schedule(_writeBuffer);
  }

  /**
   * Flush remaining events, close the file handle, and clear timers.
   * The output is inoperable after this call.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (_closed) return;
    _closed = true;

    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }

    await _schedule(async () => {
      await _writeBuffer();
      await _closeFile();
    });
  }

  return { write, flush, close };
}

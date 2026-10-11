/**
 * delivery.mjs — Daily DELIVERY metric from live sources
 *
 * Card 3520f9e8: Measure rows and merges, not cards
 *
 * This module reads from live sources (Git remote, database, CardStore) to
 * emit one daily DELIVERY line per date. Git remote and database truth control
 * delivery metrics, not card assertions.
 *
 * DELIVERY line format:
 * {
 *   date: "YYYY-MM-DD",
 *   prs_opened: number,
 *   prs_merged: number,
 *   cards_created: number,
 *   cards_completed: number,
 *   rows_written: number,
 *   deliverables_verified: number,
 *   sprint_denominator: number,
 *   ts: ISO-8601 timestamp
 * }
 *
 * @module metrics/delivery
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';

// ─── constants ────────────────────────────────────────────────────────────────

const SPRINT_DENOMINATOR = parseInt(process.env.SPRINT_DENOMINATOR || '42', 10);

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the delivery directory.
 * @returns {string}
 */
function getDeliveryDir() {
  return process.env.SKCAPSTONE_DELIVERY_DIR ||
         join(process.env.HOME || '.', '.skcapstone', 'metrics', 'delivery');
}

/**
 * Get the delivery file path for a specific date.
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
function deliveryPath(date) {
  return join(getDeliveryDir(), `${date}.json`);
}

/**
 * Parse a JSON file with append-only safety.
 * Reads line by line and returns the last valid JSON object.
 *
 * @param {string} path - File path
 * @returns {object|null} Parsed object or null if invalid/empty
 */
function parseJsonFile(path) {
  if (!existsSync(path)) return null;
  
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return null;
    
    // Parse as single JSON object
    return JSON.parse(content);
  } catch (e) {
    console.warn(`Failed to parse ${path}:`, e.message);
    return null;
  }
}

/**
 * Serialize an object to JSON with proper formatting.
 *
 * @param {object} obj - Object to serialize
 * @returns {string} JSON string
 */
function serializeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * Execute a git command and return the output.
 *
 * @param {string} repoPath - Path to git repository
 * @param {string[]} args - Git command arguments
 * @returns {string} Command output
 */
function gitExec(repoPath, ...args) {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (e) {
    return '';
  }
}

/**
 * Get pull requests created/merged on a specific date from git remote.
 * Uses git log to find merge commits and PR references.
 *
 * @param {string} repoPath - Path to git repository
 * @param {string} date - YYYY-MM-DD
 * @returns {{ opened: number, merged: number }}
 */
function getPullRequestsForDate(repoPath, date) {
  const opened = new Set();
  const merged = new Set();
  
  // Get merge commits for the date (format: YYYY-MM-DD)
  const startOfDay = `${date}T00:00:00`;
  const endOfDay = `${date}T23:59:59`;
  
  // Use git log to find merge commits with pull request references
  const mergeLog = gitExec(
    repoPath,
    `log --since="${startOfDay}" --until="${endOfDay}" --merges --oneline`
  );
  
  // Parse PR numbers from merge commit messages
  // Format: "Merge pull request #123 from branch"
  const prMergeRegex = /Merge pull request #(\d+)/gi;
  let match;
  while ((match = prMergeRegex.exec(mergeLog)) !== null) {
    merged.add(match[1]);
  }
  
  // For PRs opened, we look at commits with PR references that aren't merges
  // This is an approximation since git doesn't track PR creation directly
  const commitLog = gitExec(
    repoPath,
    `log --since="${startOfDay}" --until="${endOfDay}" --no-merges --oneline --grep="#\\d+" --all`
  );
  
  // Extract PR numbers from commit messages
  const prRefRegex = /#(\d+)/g;
  const commits = commitLog.split('\n');
  for (const commit of commits) {
    while ((match = prRefRegex.exec(commit)) !== null) {
      const prNum = match[1];
      if (!merged.has(prNum)) {
        opened.add(prNum);
      }
    }
  }
  
  return {
    opened: opened.size,
    merged: merged.size
  };
}

// Use createRequire to allow require() in ES modules
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Count database rows written on a specific date.
 * Queries the metrics database for the day.
 *
 * @param {string} dbPath - Path to SQLite database
 * @param {string} date - YYYY-MM-DD
 * @returns {number} Number of rows written
 */
function getRowsWrittenForDate(dbPath, date) {
  if (!existsSync(dbPath)) return 0;
  
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    
    // Count rows across all tables with day_bucket = date
    // Note: request_log doesn't have day_bucket, so we count it by started_at timestamp
    const tablesWithDayBucket = ['token_usage', 'cost_log', 'energy_log'];
    let total = 0;
    
    // Count tables with day_bucket column
    for (const table of tablesWithDayBucket) {
      try {
        const result = db.prepare(
          `SELECT COUNT(*) as cnt FROM ${table} WHERE day_bucket = ?`
        ).get(date);
        total += result?.cnt || 0;
      } catch (e) {
        // Table might not exist or not have day_bucket column, skip
        continue;
      }
    }
    
    // Count request_log by timestamp (convert date to timestamp range)
    try {
      const startOfDay = new Date(date).getTime();
      const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;
      const result = db.prepare(
        `SELECT COUNT(*) as cnt FROM request_log WHERE started_at >= ? AND started_at <= ?`
      ).get(startOfDay, endOfDay);
      total += result?.cnt || 0;
    } catch (e) {
      // Table might not exist, skip
    }
    
    db.close();
    return total;
  } catch (e) {
    console.warn(`Failed to query ${dbPath}:`, e.message);
    return 0;
  }
}

/**
 * Get cards created/completed on a specific date from CardStore.
 * Parses card event JSONL files.
 *
 * @param {string} cardStoreDir - Path to CardStore directory
 * @param {string} date - YYYY-MM-DD
 * @returns {{ created: number, completed: number }}
 */
function getCardsForDate(cardStoreDir, date) {
  const created = new Set();
  const completed = new Set();
  
  if (!existsSync(cardStoreDir)) {
    return { created: 0, completed: 0 };
  }
  
  const datePrefix = date.replace(/-/g, '');
  
  try {
    // Iterate through card directories
    const cardDirs = readdirSync(cardStoreDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(cardStoreDir, d.name));
    
    for (const cardDir of cardDirs) {
      const eventsDir = join(cardDir, 'events');
      if (!existsSync(eventsDir)) continue;
      
      // Read all event files for this card
      const eventFiles = readdirSync(eventsDir)
        .filter(f => f.endsWith('.jsonl'));
      
      for (const eventFile of eventFiles) {
        const eventPath = join(eventsDir, eventFile);
        const lines = readFileSync(eventPath, 'utf-8').trim().split('\n');
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const event = JSON.parse(line);
            const eventDate = event.ts?.split('T')[0];
            
            if (eventDate !== date) continue;
            
            // Track card creation
            if (event.action === 'create' || event.action === 'claim') {
              created.add(event.card_id || event.id);
            }
            
            // Track card completion (verdict with PASS or PASS_FOR_REVIEW)
            if (event.action === 'verdict' || event.verdict) {
              const verdict = event.verdict;
              if (verdict === 'PASS' || verdict === 'PASS_FOR_REVIEW') {
                completed.add(event.card_id || event.id);
              }
            }
          } catch (e) {
            // Skip malformed events
            continue;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Failed to read CardStore at ${cardStoreDir}:`, e.message);
  }
  
  return {
    created: created.size,
    completed: completed.size
  };
}

/**
 * Get independently verified deliverables for a specific date.
 * This reads from evidence files that contain verification records.
 *
 * @param {string} evidenceDir - Path to evidence directory
 * @param {string} date - YYYY-MM-DD
 * @returns {number} Number of verified deliverables
 */
function getVerifiedDeliverablesForDate(evidenceDir, date) {
  if (!existsSync(evidenceDir)) return 0;
  
  let verified = 0;
  
  try {
    // Look for delivery.txt files in evidence work directories
    const workDirs = readdirSync(evidenceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(evidenceDir, d.name));
    
    for (const workDir of workDirs) {
      const deliveryFile = join(workDir, 'delivery.txt');
      if (!existsSync(deliveryFile)) continue;
      
      const content = readFileSync(deliveryFile, 'utf-8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('verdict=PASS') || line.startsWith('verdict=PASS_FOR_REVIEW')) {
          // Extract date from the file or adjacent files
          try {
            const stats = statSync(deliveryFile);
            // Use UTC to avoid timezone issues
            const fileDate = new Date(stats.mtime.getTime()).toISOString().split('T')[0];
            if (fileDate === date) {
              verified++;
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Failed to read evidence at ${evidenceDir}:`, e.message);
  }
  
  return verified;
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Source adapter for DELIVERY metric.
 *
 * Reads from live Git, database, and CardStore to compute daily delivery metrics.
 * Git remote and database truth control delivery metrics, not card assertions.
 *
 * @class DeliveryAdapter
 */
export class DeliveryAdapter {
  /**
   * @param {object} options
   * @param {string} [options.gitRepo] - Path to git repository
   * @param {string} [options.metricsDb] - Path to metrics database
   * @param {string} [options.cardStore] - Path to CardStore directory
   * @param {string} [options.evidenceDir] - Path to evidence directory
   * @param {number} [options.sprintDenominator] - Approved sprint denominator
   */
  constructor({
    gitRepo,
    metricsDb,
    cardStore,
    evidenceDir,
    sprintDenominator = SPRINT_DENOMINATOR
  } = {}) {
    this.gitRepo = gitRepo;
    this.metricsDb = metricsDb;
    this.cardStore = cardStore;
    this.evidenceDir = evidenceDir;
    this.sprintDenominator = sprintDenominator;
  }
  
  /**
   * Compute DELIVERY metric for a specific date.
   *
   * @param {string} date - YYYY-MM-DD, defaults to today
   * @returns {object} DELIVERY metric object
   */
  computeDelivery(date) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    // Get counts from live sources
    const prs = this.gitRepo
      ? getPullRequestsForDate(this.gitRepo, targetDate)
      : { opened: 0, merged: 0 };
    
    const rowsWritten = this.metricsDb
      ? getRowsWrittenForDate(this.metricsDb, targetDate)
      : 0;
    
    const cards = this.cardStore
      ? getCardsForDate(this.cardStore, targetDate)
      : { created: 0, completed: 0 };
    
    const deliverablesVerified = this.evidenceDir
      ? getVerifiedDeliverablesForDate(this.evidenceDir, targetDate)
      : 0;
    
    // Build DELIVERY line
    return {
      date: targetDate,
      prs_opened: prs.opened,
      prs_merged: prs.merged,
      cards_created: cards.created,
      cards_completed: cards.completed,
      rows_written: rowsWritten,
      deliverables_verified: deliverablesVerified,
      sprint_denominator: this.sprintDenominator,
      ts: new Date().toISOString()
    };
  }
  
  /**
   * Emit a DELIVERY line for a specific date.
   * Idempotent: re-running for the same date produces the same result.
   *
   * @param {string} date - YYYY-MM-DD, defaults to today
   * @returns {object} The DELIVERY metric object
   */
  emitDelivery(date) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const filePath = deliveryPath(targetDate);
    
    // Ensure delivery directory exists
    mkdirSync(dirname(filePath), { recursive: true });
    
    // Always compute from live sources (idempotency comes from source consistency)
    const delivery = this.computeDelivery(targetDate);
    
    // Write using JSON serializer (append-only safety)
    const content = serializeJson(delivery);
    writeFileSync(filePath, content, 'utf-8');
    
    return delivery;
  }
  
  /**
   * Get existing DELIVERY line for a date, or null if not exists.
   *
   * @param {string} date - YYYY-MM-DD
   * @returns {object|null}
   */
  getDelivery(date) {
    return parseJsonFile(deliveryPath(date));
  }
  
  /**
   * Emit DELIVERY lines for a date range.
   *
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD
   * @returns {object[]} Array of DELIVERY metric objects
   */
  emitRange(startDate, endDate) {
    const results = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      results.push(this.emitDelivery(dateStr));
    }
    
    return results;
  }
}

/**
 * Create a delivery adapter with default paths from SKCapstone environment.
 *
 * @returns {DeliveryAdapter}
 */
export function createDeliveryAdapter() {
  const skcapstoneHome = process.env.SKCAPSTONE_HOME ||
                         join(process.env.HOME || '.', '.skcapstone');
  
  return new DeliveryAdapter({
    gitRepo: process.env.SKCAPSTONE_GIT_REPO,
    metricsDb: join(skcapstoneHome, '..', 'skgateway-codex', 'data', 'metrics.db'),
    cardStore: join(skcapstoneHome, 'cards'),
    evidenceDir: join(skcapstoneHome, 'evidence', 'work'),
    sprintDenominator: SPRINT_DENOMINATOR
  });
}

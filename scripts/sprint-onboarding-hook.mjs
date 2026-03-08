#!/usr/bin/env node
/**
 * Sprint Onboarding Hook — PreToolUse
 *
 * Fires before the FIRST tool call in any session where a sprint is active.
 * Crawls memory for sprint-specific gotchas, patterns, and constraints.
 * Injects sprint context so the agent starts with the full map.
 *
 * This hook is idempotent: it fires once per session (writes a state file).
 * Subsequent tool calls skip the onboarding.
 *
 * Hook type: PreToolUse (matcher: "" = all tools)
 * Stdin: JSON with { tool_name, tool_input, session_id, cwd }
 * Stdout: Context message shown to Claude (if any)
 * Exit 0: proceed, Exit 2: block (we never block, just inform)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ==================== CONFIG ====================

const DB_DIR = join(homedir(), '.shieldcortex');
const DB_PATH = join(DB_DIR, 'memories.db');
const STATE_DIR = join(homedir(), '.claude', '.sprint-onboarding-state');
const SPRINT_GUIDE_PATH = join(
  homedir(),
  'Documents', 'dayThoughts', 'Agent Rundown',
  'Consolidation Architecture', '06 - Sprint Execution Master Guide.md'
);

// Sprint-specific search terms for memory recall
// Legacy sprints (ShieldCortex-only) + Unified M-series (Trust + L402 Marketplace)
const SPRINT_KEYWORDS = {
  // Legacy ShieldCortex sprints
  '1': ['tool-gateway', 'event-store', 'trace-context', 'hash-utils', 'hash chain', 'AsyncLocalStorage', 'better-sqlite3', 'WAL mode', 'single-writer'],
  '1.5': ['capability-manager', 'content-sanitizer', 'chain-anchor', 'pino', 'invariants', 'console.log sweep', 'capability tokens'],
  '2': ['report-generator', 'scheduler', 'sentinel-pulse', 'INV-008', 'flight recorder', 'daily briefing', 'cost tracking'],
  '3': ['dashboard', 'trace-tree', 'policy-explorer', 'agent-scoreboard', 'React', 'WebSocket', 'mobile layout'],
  '4': ['sentinel', 'anomaly-detector', 'alert-manager', 'health checks', 'chain verification', 'crash-resilient'],
  '5': ['step-up', 'policy-engine', 'sprint-enforcer', 'two-phase commit', 'risk score', 'emergency override'],
  '6': ['injection', 'sanitizer', 'test harness', 'CI', 'base64', 'unicode homoglyph', 'INV-005'],
  // Unified M-series sprints (Trust + L402 Marketplace)
  'M0': ['VPS', 'DigitalOcean', 'Caddy', 'Docker', 'LND', 'Lightning', 'drakon.systems', 'reverse proxy', 'lncli'],
  'M1': ['L402', 'Lightning', 'paywall', 'LND', 'macaroon', 'invoice', 'preimage', 'lnd_client', 'multiFetch', 'YouTube transcription', '402'],
  'M2': ['event-ledger', 'hash-chain', 'marketplace_events', 'payment events', 'single-writer queue', 'WAL', 'chain verification', 'hash-utils'],
  'M3': ['MCP registry', 'wallet-controller', 'l402-client', 'tool-gateway', 'autonomous agent', 'discover tools', 'marketplace consumer', 'budget'],
  'M4': ['provider-scorer', 'trust scoring', 'tool ratings', 'Moody', 'grade bands', 'price-validator', 'reputation', 'leaderboard'],
  'M5': ['kill-switch', 'spending-monitor', 'velocity', 'freeze wallet', 'halt marketplace', 'graduated response', 'THROTTLE', 'SUSPEND'],
  'M6': ['sentinel', 'report-generator', 'scheduler', 'chain anchor', 'anomaly detection', 'daily briefing', 'marketplace monitor'],
  'M7': ['dashboard', 'trace tree', 'spending dashboard', 'ratings board', 'kill-switch panel', 'chain health', 'mobile'],
  'M8': ['hardening', 'capability tokens', 'invariants', 'content sanitizer', 'second tool', 'multi-tool marketplace'],
};

// ==================== STATE MANAGEMENT ====================

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function getStateFile(sessionId) {
  return join(STATE_DIR, `${sessionId || 'default'}.json`);
}

function hasOnboarded(sessionId) {
  const stateFile = getStateFile(sessionId);
  if (!existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return state.onboarded === true;
  } catch {
    return false;
  }
}

function markOnboarded(sessionId, sprintId) {
  ensureStateDir();
  const stateFile = getStateFile(sessionId);
  writeFileSync(stateFile, JSON.stringify({
    onboarded: true,
    sprint: sprintId,
    timestamp: new Date().toISOString()
  }));
}

// ==================== SPRINT DETECTION ====================

function detectActiveSprint() {
  // Check for active sprint indicators:
  // 1. Environment variable ACTIVE_SPRINT
  // 2. Sprint state file
  // 3. Memory-based detection (look for in-progress sprint memories)

  // Method 1: Environment variable
  if (process.env.ACTIVE_SPRINT) {
    return process.env.ACTIVE_SPRINT;
  }

  // Method 2: Sprint state file
  const sprintStateFile = join(STATE_DIR, 'active-sprint.json');
  if (existsSync(sprintStateFile)) {
    try {
      const state = JSON.parse(readFileSync(sprintStateFile, 'utf-8'));
      if (state.sprint && state.active) {
        return state.sprint;
      }
    } catch {
      // ignore parse errors
    }
  }

  // Method 3: Check memory for active sprint
  if (existsSync(DB_PATH)) {
    try {
      const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
      const result = db.prepare(`
        SELECT content FROM memories
        WHERE category = 'todo'
          AND content LIKE '%sprint%'
          AND content LIKE '%in progress%'
        ORDER BY created_at DESC
        LIMIT 1
      `).get();
      db.close();

      if (result) {
        // Extract sprint number from content
        const match = result.content.match(/sprint\s*(M?\d+(?:\.\d+)?)/i);
        if (match) return match[1];
      }
    } catch {
      // ignore db errors
    }
  }

  return null;
}

// ==================== MEMORY RETRIEVAL ====================

function getSprintMemories(db, sprintId) {
  const keywords = SPRINT_KEYWORDS[sprintId] || [];
  if (keywords.length === 0) return [];

  const memories = [];

  // Search for each keyword using FTS5
  for (const keyword of keywords) {
    try {
      const results = db.prepare(`
        SELECT DISTINCT m.id, m.title, m.content, m.category, m.salience
        FROM memories m
        WHERE (m.content LIKE ? OR m.title LIKE ?)
          AND m.salience >= 0.5
        ORDER BY m.salience DESC
        LIMIT 5
      `).all(`%${keyword}%`, `%${keyword}%`);

      for (const r of results) {
        if (!memories.find(m => m.id === r.id)) {
          memories.push(r);
        }
      }
    } catch {
      // ignore individual search failures
    }
  }

  // Sort by salience, limit to top 10
  memories.sort((a, b) => b.salience - a.salience);
  return memories.slice(0, 10);
}

// ==================== GOTCHA EXTRACTION ====================

function extractGotchas(sprintId) {
  if (!existsSync(SPRINT_GUIDE_PATH)) return null;

  try {
    const guide = readFileSync(SPRINT_GUIDE_PATH, 'utf-8');

    // Find the sprint section and extract gotchas
    const sprintLabel = sprintId.startsWith('M') ? `Sprint ${sprintId}` : (sprintId === '1.5' ? 'Sprint 1.5' : `Sprint ${sprintId}`);
    const sprintRegex = new RegExp(`## ${sprintLabel}:.*?(?=\\n## (?:Pre-)?Sprint [M\\d]|$)`, 's');
    const sprintSection = guide.match(sprintRegex);

    if (!sprintSection) return null;

    // Extract gotcha blocks (lines starting with > **G)
    const gotchaRegex = /> \*\*G[\d.]+-\d+:.*?\n(?:>.*\n)*/g;
    const gotchas = sprintSection[0].match(gotchaRegex);

    if (!gotchas || gotchas.length === 0) return null;

    return gotchas.map(g => g.replace(/^> /gm, '').trim());
  } catch {
    return null;
  }
}

// ==================== FORMAT OUTPUT ====================

function formatOnboardingContext(sprintId, memories, gotchas) {
  const lines = [
    `🏃 SPRINT ONBOARDING — Sprint ${sprintId}`,
    '',
    'The following context has been loaded from persistent memory and sprint guides.',
    'Review this before proceeding with any tool calls.',
    ''
  ];

  if (memories.length > 0) {
    lines.push('## Relevant Memories');
    lines.push('');
    for (const mem of memories) {
      const truncated = mem.content.length > 300
        ? mem.content.slice(0, 300) + '...'
        : mem.content;
      lines.push(`- **${mem.title}** [${mem.category}]`);
      lines.push(`  ${truncated}`);
    }
    lines.push('');
  }

  if (gotchas && gotchas.length > 0) {
    lines.push('## Sprint Gotchas (Pre-Populated Landmines)');
    lines.push('');
    for (const gotcha of gotchas) {
      lines.push(gotcha);
      lines.push('');
    }
  }

  lines.push('## Sprint Execution Rules');
  lines.push('');
  lines.push('1. Read the full sprint guide before starting implementation');
  lines.push('2. Check acceptance criteria BEFORE writing code');
  lines.push('3. Follow the file creation order from the guide');
  lines.push('4. Run build + tests after each file');
  lines.push('5. Do NOT modify files outside the declared scope');
  lines.push('6. Save decisions and patterns to memory as you go');
  lines.push('');

  return lines.join('\n');
}

// ==================== MAIN ====================

let input = '';
process.stdin.setEncoding('utf8');

process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input || '{}');
    const sessionId = hookData.session_id || 'unknown';

    // Idempotency: skip if already onboarded this session
    if (hasOnboarded(sessionId)) {
      process.exit(0);
    }

    // Detect active sprint
    const sprintId = detectActiveSprint();
    if (!sprintId) {
      // No active sprint — skip onboarding
      process.exit(0);
    }

    // Retrieve sprint-specific memories
    let memories = [];
    if (existsSync(DB_PATH)) {
      try {
        const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
        memories = getSprintMemories(db, sprintId);
        db.close();
      } catch (err) {
        console.error(`[sprint-onboarding] DB error: ${err.message}`);
      }
    }

    // Extract gotchas from sprint guide
    const gotchas = extractGotchas(sprintId);

    // Format and output
    const context = formatOnboardingContext(sprintId, memories, gotchas);
    console.log(context);

    // Mark as onboarded
    markOnboarded(sessionId, sprintId);

    console.error(`[sprint-onboarding] Sprint ${sprintId}: loaded ${memories.length} memories, ${gotchas?.length || 0} gotchas`);
    process.exit(0);

  } catch (error) {
    console.error(`[sprint-onboarding] Error: ${error.message}`);
    process.exit(0); // Never block on errors
  }
});

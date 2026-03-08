#!/usr/bin/env node
/**
 * Sprint Prep — Pre-crawls sprint context and generates the state file.
 *
 * Run BEFORE starting a sprint to:
 *   1. Extract gotchas from the sprint plan doc
 *   2. Extract files_remaining from the sprint plan
 *   3. Extract acceptance criteria
 *   4. Search memory DB for relevant memory IDs
 *   5. Write the populated sprint state file
 *   6. Optionally generate a research template for the sprint
 *
 * Usage:
 *   node sprint-prep.mjs M1
 *   node sprint-prep.mjs M1 --generate-template
 *
 * Reads from:
 *   - ~/Documents/dayThoughts/Agent Rundown/trust-marketplace-sprint-plan.md (M-series)
 *   - ~/Documents/dayThoughts/Agent Rundown/Consolidation Architecture/06 - Sprint Execution Master Guide.md (legacy)
 *   - ShieldCortex memory DB for keyword searches
 *
 * Writes to:
 *   - ~/.claude/.sprint-onboarding-state/sprint-{id}-state.json
 *   - ~/claudegram/research/sprints/sprint-{id}-onboarding.md (if --generate-template)
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.claude', '.sprint-onboarding-state');
const MARKETPLACE_PLAN = join(homedir(), 'Documents', 'dayThoughts', 'Agent Rundown', 'trust-marketplace-sprint-plan.md');
const LEGACY_GUIDE = join(homedir(), 'Documents', 'dayThoughts', 'Agent Rundown', 'Consolidation Architecture', '06 - Sprint Execution Master Guide.md');
const DB_PATH = join(homedir(), '.shieldcortex', 'memories.db');

function resolveResearchDir() {
  if (process.env.SPRINT_RESEARCH_DIR) {
    return process.env.SPRINT_RESEARCH_DIR;
  }

  const candidates = [
    join(homedir(), 'Desktop', 'Projects', 'claudegram', 'research', 'sprints'),
    join(homedir(), 'claudegram', 'research', 'sprints'),
  ];

  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

const RESEARCH_DIR = resolveResearchDir();

// M-series keyword map (same as onboarding hook)
const SPRINT_KEYWORDS = {
  'M0': ['VPS', 'DigitalOcean', 'Caddy', 'Docker', 'LND', 'Lightning', 'drakon.systems'],
  'M1': ['L402', 'Lightning', 'paywall', 'LND', 'macaroon', 'invoice', 'preimage', 'multiFetch', 'YouTube'],
  'M2': ['event-ledger', 'hash-chain', 'marketplace_events', 'payment events', 'single-writer', 'WAL', 'hash-utils'],
  'M3': ['MCP registry', 'wallet-controller', 'l402-client', 'tool-gateway', 'autonomous', 'marketplace consumer'],
  'M4': ['provider-scorer', 'trust scoring', 'tool ratings', 'Moody', 'reputation', 'price-validator'],
  'M5': ['kill-switch', 'spending-monitor', 'velocity', 'freeze', 'halt marketplace', 'graduated response'],
  'M6': ['sentinel', 'report-generator', 'scheduler', 'chain anchor', 'anomaly detection', 'daily briefing'],
  'M7': ['dashboard', 'trace tree', 'spending dashboard', 'ratings board', 'kill-switch panel'],
  'M8': ['hardening', 'capability tokens', 'invariants', 'content sanitizer', 'second tool'],
};

// ==================== PLAN PARSING ====================

function extractSprintSection(sprintId) {
  const isM = sprintId.startsWith('M');
  const planPath = isM ? MARKETPLACE_PLAN : LEGACY_GUIDE;

  if (!existsSync(planPath)) {
    console.error(`[sprint-prep] Plan not found: ${planPath}`);
    return null;
  }

  const plan = readFileSync(planPath, 'utf-8');

  // Find the sprint section
  const escaped = sprintId.replace('.', '\\.');
  const regex = new RegExp(`## (?:Pre-)?Sprint ${escaped}:?.*?(?=\\n## (?:Pre-)?Sprint [M\\d]|\\n## CHECKPOINT|\\n## Sprint Dependency|$)`, 's');
  const match = plan.match(regex);
  return match ? match[0] : null;
}

function extractFilesToCreate(section) {
  if (!section) return [];
  const files = [];
  const patterns = [
    /\*\*`([^`]+)`\*\*/g,
    /^\d+\.\s+\*\*`([^`]+)`\*\*/gm,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(section)) !== null) {
      if (m[1].includes('/') || m[1].includes('.')) {
        files.push(m[1]);
      }
    }
  }
  return [...new Set(files)];
}

function extractFilesToModify(section) {
  if (!section) return [];
  const files = [];
  const modSection = section.match(/### Files to Modify[\s\S]*?(?=###|$)/);
  if (modSection) {
    const pat = /\*\*`([^`]+)`\*\*/g;
    let m;
    while ((m = pat.exec(modSection[0])) !== null) {
      files.push(m[1]);
    }
  }
  return files;
}

function extractGotchas(section) {
  if (!section) return [];
  const gotchas = [];
  const regex = />\s*\*\*(M?\d[^*]*)\*\*\s*\n((?:>.*\n)*)/g;
  let m;
  while ((m = regex.exec(section)) !== null) {
    const label = m[1].trim();
    const body = m[2].replace(/^>\s*/gm, '').trim();
    gotchas.push({ label, body });
  }
  return gotchas;
}

function extractAcceptanceCriteria(section) {
  if (!section) return [];
  const criteria = [];
  const regex = /- \[ \]\s+(.+)/g;
  let m;
  while ((m = regex.exec(section)) !== null) {
    criteria.push(m[1].trim());
  }
  return criteria;
}

function extractAgentAssignment(section) {
  if (!section) return null;
  const m = section.match(/### Agent Assignment:\s*(.+)/);
  return m ? m[1].trim() : null;
}

// ==================== MEMORY SEARCH ====================

function searchMemories(sprintId) {
  const keywords = SPRINT_KEYWORDS[sprintId] || [];
  if (keywords.length === 0 || !existsSync(DB_PATH)) return [];

  try {
    const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
    const found = new Map();

    for (const keyword of keywords) {
      const results = db.prepare(`
        SELECT id, title, category, salience
        FROM memories
        WHERE (content LIKE ? OR title LIKE ?)
          AND salience >= 0.4
        ORDER BY salience DESC
        LIMIT 3
      `).all(`%${keyword}%`, `%${keyword}%`);

      for (const r of results) {
        if (!found.has(r.id)) found.set(r.id, r);
      }
    }

    db.close();
    return [...found.values()].sort((a, b) => b.salience - a.salience).slice(0, 15);
  } catch (err) {
    console.error(`[sprint-prep] DB error: ${err.message}`);
    return [];
  }
}

// ==================== TEMPLATE GENERATION ====================

function generateTemplate(sprintId, section, gotchas, filesToCreate, filesToModify, criteria, agent) {
  const objective = section ? (section.match(/### Objective\s*\n([\s\S]*?)(?=\n###)/)?.[1]?.trim() || 'See sprint plan.') : 'See sprint plan.';

  const lines = [
    `# Sprint ${sprintId} — Agent Onboarding Doc`,
    '',
    `> Generated: ${new Date().toISOString()}`,
    `> Agent Assignment: ${agent || 'TBD'}`,
    '',
    '---',
    '',
    '## MISSION',
    '',
    objective,
    '',
    '## FILES TO CREATE',
    '',
    ...filesToCreate.map(f => `- [ ] \`${f}\``),
    '',
    '## FILES TO MODIFY',
    '',
    ...filesToModify.map(f => `- [ ] \`${f}\``),
    '',
    '## GOTCHAS',
    '',
    ...gotchas.map(g => `> **${g.label}**\n> ${g.body}\n`),
    '',
    '## ACCEPTANCE CRITERIA',
    '',
    ...criteria.map(c => `- [ ] ${c}`),
    '',
    '## CONSTRAINTS',
    '',
    '- Do NOT modify files outside the declared scope',
    '- Run `npx tsc --noEmit` after each file',
    '- Save decisions to memory as you go',
    '- Use `sprint-checkpoint.mjs` to track progress',
    '',
    '---',
    '',
    '*Generated by sprint-prep.mjs*',
  ];
  return lines.join('\n');
}

// ==================== MAIN ====================

const sprintId = process.argv[2];
const genTemplate = process.argv.includes('--generate-template');

if (!sprintId || sprintId === '--help') {
  console.log(`sprint-prep — Pre-crawl sprint context and generate state file

Usage:
  node sprint-prep.mjs <sprint_id> [--generate-template]

Examples:
  node sprint-prep.mjs M1
  node sprint-prep.mjs M1 --generate-template

Sprint IDs: M0, M1, M2, M3, M4, M5, M6, M7, M8 (unified)
            1, 1.5, 2, 3, 4, 5, 6 (legacy ShieldCortex)`);
  process.exit(0);
}

console.log(`[sprint-prep] Preparing sprint ${sprintId}...`);

// 1. Extract sprint section from plan
const section = extractSprintSection(sprintId);
if (!section) {
  console.error(`[sprint-prep] Could not find sprint ${sprintId} in plan docs.`);
  process.exit(1);
}
console.log(`[sprint-prep] Found sprint section (${section.length} chars)`);

// 2. Parse structured data
const filesToCreate = extractFilesToCreate(section);
const filesToModify = extractFilesToModify(section);
const gotchas = extractGotchas(section);
const criteria = extractAcceptanceCriteria(section);
const agent = extractAgentAssignment(section);

console.log(`[sprint-prep] Files: ${filesToCreate.length} create, ${filesToModify.length} modify`);
console.log(`[sprint-prep] Gotchas: ${gotchas.length}, Criteria: ${criteria.length}`);

// 3. Search memory for relevant IDs
const memories = searchMemories(sprintId);
console.log(`[sprint-prep] Memory search: ${memories.length} relevant memories found`);
for (const m of memories) {
  console.log(`  [${m.category}] ${m.title} (ID:${m.id}, salience:${m.salience})`);
}

// 4. Write state file
mkdirSync(STATE_DIR, { recursive: true });
const stateFile = join(STATE_DIR, `sprint-${sprintId}-state.json`);
const state = {
  sprint: sprintId,
  status: 'prep',
  phase: 'prep',
  current_file: filesToCreate[0] || null,
  files_completed: [],
  files_remaining: filesToCreate.map(f => ({ path: f, type: 'create' }))
    .concat(filesToModify.map(f => ({ path: f, type: 'modify' }))),
  memory_ids: memories.map(m => m.id),
  docs: {
    reference: sprintId.startsWith('M') ? MARKETPLACE_PLAN : LEGACY_GUIDE,
    onboarding: null,
  },
  acceptance_criteria: criteria,
  gotchas: gotchas.map(g => `${g.label}: ${g.body}`),
  agent_assignment: agent,
  decisions: [],
  blockers: [],
  created_at: new Date().toISOString(),
};

writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log(`[sprint-prep] State file written: ${stateFile}`);

// 5. Generate research template if requested
if (genTemplate) {
  mkdirSync(RESEARCH_DIR, { recursive: true });
  const templatePath = join(RESEARCH_DIR, `sprint-${sprintId}-onboarding.md`);
  const template = generateTemplate(sprintId, section, gotchas, filesToCreate, filesToModify, criteria, agent);
  writeFileSync(templatePath, template);
  state.docs.onboarding = templatePath;
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`[sprint-prep] Template written: ${templatePath}`);
}

console.log(`\n[sprint-prep] Sprint ${sprintId} ready. Next steps:`);
console.log(`  1. Review state: cat ${stateFile}`);
console.log(`  2. Activate sprint: sprint-ctl set ${sprintId}`);
console.log(`  3. Start orchestrator: /sprint-orchestrator ${sprintId}`);

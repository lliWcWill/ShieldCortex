#!/usr/bin/env node
/**
 * Sprint Checkpoint — Saves sprint progress to the state file.
 *
 * Called by agents (or hooks) to persist progress mid-sprint so that
 * context recovery after compaction or session restart picks up where
 * the agent left off.
 *
 * Usage (CLI):
 *   node sprint-checkpoint.mjs --phase execute --current-file src/foo.ts
 *   node sprint-checkpoint.mjs --complete src/bar.ts
 *   node sprint-checkpoint.mjs --decision "Used REST bridge over shared SQLite"
 *   node sprint-checkpoint.mjs --blocker "LND macaroon path not found"
 *   node sprint-checkpoint.mjs --memory-id 504
 *   node sprint-checkpoint.mjs --show
 *
 * Also usable as a module:
 *   import { checkpoint } from './sprint-checkpoint.mjs';
 *   checkpoint({ phase: 'execute', currentFile: 'src/foo.ts' });
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.claude', '.sprint-onboarding-state');
const ACTIVE_FILE = join(STATE_DIR, 'active-sprint.json');

function getActiveSprint() {
  if (!existsSync(ACTIVE_FILE)) return null;
  try {
    const state = JSON.parse(readFileSync(ACTIVE_FILE, 'utf-8'));
    if (!state.sprint || !state.active) return null;
    return state.sprint;
  } catch {
    return null;
  }
}

function getStateFile(sprintId) {
  return join(STATE_DIR, `sprint-${sprintId}-state.json`);
}

function loadState(sprintId) {
  const file = getStateFile(sprintId);
  if (!existsSync(file)) {
    // Auto-scaffold if missing
    return {
      sprint: sprintId,
      status: 'in_progress',
      phase: 'prep',
      current_file: null,
      files_completed: [],
      files_remaining: [],
      memory_ids: [],
      docs: { reference: null, onboarding: null },
      acceptance_criteria: [],
      decisions: [],
      blockers: [],
      created_at: new Date().toISOString(),
    };
  }
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function saveState(sprintId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  state.updated_at = new Date().toISOString();
  writeFileSync(getStateFile(sprintId), JSON.stringify(state, null, 2));
}

export function checkpoint(updates) {
  const sprintId = getActiveSprint();
  if (!sprintId) {
    throw new Error('[sprint-checkpoint] No active sprint');
  }

  const state = loadState(sprintId);

  if (updates.phase) state.phase = updates.phase;
  if (updates.status) state.status = updates.status;
  if (updates.currentFile) state.current_file = updates.currentFile;

  if (updates.completeFile) {
    // Move file from remaining to completed
    const file = updates.completeFile;
    state.files_remaining = (state.files_remaining || []).filter(f =>
      typeof f === 'string' ? f !== file : f.path !== file
    );
    if (!state.files_completed.find(f => (typeof f === 'string' ? f : f.path) === file)) {
      state.files_completed.push({ path: file, completed_at: new Date().toISOString() });
    }
    // Advance current_file to next remaining
    state.current_file = state.files_remaining[0]
      ? (typeof state.files_remaining[0] === 'string' ? state.files_remaining[0] : state.files_remaining[0].path)
      : null;
  }

  if (updates.decision) {
    state.decisions = state.decisions || [];
    state.decisions.push({ text: updates.decision, at: new Date().toISOString() });
  }

  if (updates.blocker) {
    state.blockers = state.blockers || [];
    if (!state.blockers.includes(updates.blocker)) {
      state.blockers.push(updates.blocker);
    }
  }

  if (updates.clearBlocker) {
    state.blockers = (state.blockers || []).filter(b => b !== updates.clearBlocker);
  }

  if (updates.memoryId) {
    state.memory_ids = state.memory_ids || [];
    const id = Number(updates.memoryId);
    if (!state.memory_ids.includes(id)) {
      state.memory_ids.push(id);
    }
  }

  if (updates.docs) {
    state.docs = { ...state.docs, ...updates.docs };
  }

  saveState(sprintId, state);
  return state;
}

// ==================== CLI ====================

if (process.argv[1] && process.argv[1].endsWith('sprint-checkpoint.mjs')) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`sprint-checkpoint — Save sprint progress to state file

Usage:
  --phase <phase>           Set current phase (prep|execute|review|commit)
  --current-file <path>     Set the file currently being worked on
  --complete <path>         Mark a file as completed
  --decision "<text>"       Record an architectural decision
  --blocker "<text>"        Record a blocker
  --clear-blocker "<text>"  Remove a blocker
  --memory-id <id>          Add a memory ID to the sprint context
  --doc-reference <path>    Set the reference doc path
  --doc-onboarding <path>   Set the onboarding doc path
  --show                    Display current sprint state`);
    process.exit(0);
  }

  if (args.includes('--show')) {
    const sprintId = getActiveSprint();
    if (!sprintId) {
      console.log('No active sprint.');
    } else {
      const state = loadState(sprintId);
      console.log(JSON.stringify(state, null, 2));
    }
    process.exit(0);
  }

  const updates = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--phase': updates.phase = args[++i]; break;
      case '--current-file': updates.currentFile = args[++i]; break;
      case '--complete': updates.completeFile = args[++i]; break;
      case '--decision': updates.decision = args[++i]; break;
      case '--blocker': updates.blocker = args[++i]; break;
      case '--clear-blocker': updates.clearBlocker = args[++i]; break;
      case '--memory-id': updates.memoryId = args[++i]; break;
      case '--doc-reference': updates.docs = { ...updates.docs, reference: args[++i] }; break;
      case '--doc-onboarding': updates.docs = { ...updates.docs, onboarding: args[++i] }; break;
    }
  }

  if (Object.keys(updates).length > 0) {
    try {
      const state = checkpoint(updates);
      console.log(`[sprint-checkpoint] Updated sprint ${state.sprint} — phase: ${state.phase}, files: ${state.files_completed.length} done, ${state.files_remaining.length} remaining`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

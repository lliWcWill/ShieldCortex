/**
 * Pattern-based entity and triple extraction engine.
 * Extracts entities (files, languages, tools, people, concepts) and
 * relationship triples from memory title + content using pure regex matching.
 */

export type EntityType = 'person' | 'tool' | 'concept' | 'file' | 'language' | 'service' | 'pattern';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  triples: ExtractedTriple[];
}

const LANGUAGES = new Set([
  'TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'SQL', 'HTML', 'CSS',
  'Ruby', 'Java', 'C++', 'C#', 'Swift', 'Kotlin', 'Scala', 'Elixir',
  'Haskell', 'Lua', 'PHP', 'Perl', 'Shell', 'Bash', 'Zsh',
]);

const TOOLS_AND_SERVICES = new Set([
  'PostgreSQL', 'Redis', 'Docker', 'SQLite', 'Express', 'React', 'Next.js',
  'Node.js', 'npm', 'pnpm', 'yarn', 'git', 'GitHub', 'GitLab', 'Vercel',
  'AWS', 'Azure', 'GCP', 'MongoDB', 'MySQL', 'Prisma', 'Drizzle',
  'Webpack', 'Vite', 'ESLint', 'Prettier', 'Jest', 'Vitest', 'Playwright',
  'Cypress', 'Tailwind', 'MCP',
]);

// Lowercase lookup for case-insensitive matching
const TOOLS_LOWER = new Map<string, string>();
for (const t of TOOLS_AND_SERVICES) {
  TOOLS_LOWER.set(t.toLowerCase(), t);
}

const LANGUAGES_LOWER = new Map<string, string>();
for (const l of LANGUAGES) {
  LANGUAGES_LOWER.set(l.toLowerCase(), l);
}

const PASCAL_CASE_FALSE_POSITIVES = new Set([
  'README', 'TODO', 'IMPORTANT', 'NOTE', 'CREATE', 'INSERT', 'SELECT',
  'UPDATE', 'DELETE', 'WHERE', 'FROM', 'NULL', 'TRUE', 'FALSE', 'THEN',
  'ELSE', 'WHEN', 'CASE', 'INTO', 'TABLE', 'INDEX', 'ALTER', 'DROP',
  'BEGIN', 'COMMIT', 'ROLLBACK',
]);

// Generic words that should never become entities
const STOPWORDS = new Set([
  'project', 'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'shall', 'can', 'need', 'must', 'it', 'its', 'we', 'our', 'my', 'your',
  'not', 'no', 'yes', 'all', 'any', 'some', 'each', 'every', 'both',
  'new', 'old', 'first', 'last', 'next', 'now', 'then', 'here', 'there',
  'up', 'down', 'out', 'in', 'on', 'off', 'over', 'under', 'more', 'less',
  'also', 'just', 'only', 'very', 'still', 'already', 'always', 'never',
  'added', 'built', 'made', 'set', 'got', 'put', 'run', 'let', 'get',
  'use', 'used', 'using', 'make', 'take', 'keep', 'work', 'call',
  'issue', 'issues', 'fix', 'fixed', 'bug', 'error', 'change', 'changes',
  'feature', 'step', 'phase', 'task', 'item', 'thing', 'things',
  'way', 'part', 'type', 'kind', 'form', 'case', 'point', 'end', 'start',
  'data', 'code', 'file', 'function', 'class', 'method', 'system', 'test',
  'cross', 'visual', 'auto', 'default', 'custom', 'main', 'base',
  'uses', 'with', 'for', 'from', 'after', 'before', 'same', 'key',
  'other', 'into', 'about', 'when', 'where', 'how', 'what', 'which',
  'notes', 'note', 'decisions', 'decision', 'discoveries', 'editing',
  'making', 'matching', 'update', 'updates', 'network', 'design',
  'pattern', 'approach', 'strategy', 'architecture', 'principle',
  'extraction', 'implementation', 'configuration', 'optimization',
]);

const FILE_EXT_SCAN_RE = /\b[\w./-]+\.(ts|py|js|sql|json|md|tsx|jsx|rs|go|css|html)\b/g;
const FILE_EXT_ENTITY_RE = /\b[\w./-]+\.(ts|py|js|sql|json|md|tsx|jsx|rs|go|css|html)\b/i;
const DIR_PATH_RE = /\b(src|lib|dist|tests?|scripts?|dashboard)\/[\w./-]+\b/g;
const USERNAME_RE = /@(\w+)/g;
const NAME_SAID_RE = /\b([A-Z][a-z]+)\s+(?:said|mentioned|suggested|noted|asked|proposed)\b/g;
const PASCAL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
const BEFORE_KEYWORD_RE = /\b(\w+)\s+(?:database|server|API|framework|library|plugin|extension)\b/g;
const CONCEPT_RE = /\b(?:architecture|pattern|approach|strategy|design)\s+(?:is\s+)?(\w[\w\s-]{0,30}?\w)\b/gi;
const CONCEPT_BEFORE_RE = /\b([\w-]+)\s+(?:architecture|pattern|approach|strategy|design)\b/gi;
const REL_ENTITY_PART = String.raw`[\w./-]+`;
const REL_ENTITY_RE = String.raw`(${REL_ENTITY_PART}(?:\s+${REL_ENTITY_PART}){0,5})`;
const LEADING_HEDGE_RE = /^(?:(?:i think|maybe|not sure(?: but)?|looks like|seems like|apparently)\s+)+/i;
const REPORTING_PREFIX_RE = /^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+says\s+)/;
const TRAILING_HELPER_RE = /\s+(?:is|was|are|were)$/i;
const SERVICE_SUFFIX_WORDS = new Set(['api', 'server', 'service', 'plugin', 'framework', 'library', 'database']);
const ENTITY_ALIASES = new Map<string, { name: string; type: EntityType }>([
  ['smart receive api', { name: 'Smart Receive API', type: 'service' }],
  ['smart receive', { name: 'Smart Receive API', type: 'service' }],
  ['sr api', { name: 'Smart Receive API', type: 'service' }],
]);

export function extractFromMemory(title: string, content: string, category: string): ExtractionResult {
  const text = (title || '') + '\n' + (content || '');
  if (text.trim().length < 2) {
    return { entities: [], triples: [] };
  }

  const entityMap = new Map<string, ExtractedEntity>();

  function addEntity(name: string, type: EntityType): void {
    const alias = ENTITY_ALIASES.get(name.toLowerCase());
    if (alias) {
      name = alias.name;
      type = alias.type;
    }
    if (STOPWORDS.has(name.toLowerCase())) return;
    if (name.length < 2) return;
    const key = `${name}::${type}`;
    if (!entityMap.has(key)) {
      entityMap.set(key, { name, type });
    }
  }

  // --- Entity extraction ---

  // Files
  for (const m of text.matchAll(FILE_EXT_SCAN_RE)) {
    addEntity(m[0], 'file');
  }
  for (const m of text.matchAll(DIR_PATH_RE)) {
    // Skip if already captured as a file with extension
    const val = m[0];
    if (!entityMap.has(`${val}::file`)) {
      addEntity(val, 'file');
    }
  }

  // Languages
  for (const lang of LANGUAGES) {
    // Build a regex that handles special chars like C++ and C#
    const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'g');
    if (re.test(text)) {
      addEntity(lang, 'language');
    }
  }

  // Tools/services — exact match
  for (const [lower, canonical] of TOOLS_LOWER) {
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (re.test(text)) {
      addEntity(canonical, 'tool');
    }
  }

  // PascalCase words (tools)
  for (const m of text.matchAll(PASCAL_CASE_RE)) {
    const word = m[1];
    if (!PASCAL_CASE_FALSE_POSITIVES.has(word.toUpperCase()) &&
        !LANGUAGES.has(word) &&
        !TOOLS_AND_SERVICES.has(word)) {
      addEntity(word, 'tool');
    }
  }

  // Words before "database", "server", etc.
  for (const m of text.matchAll(BEFORE_KEYWORD_RE)) {
    const word = m[1];
    if (word.length > 1 &&
        !PASCAL_CASE_FALSE_POSITIVES.has(word.toUpperCase()) &&
        !['the', 'a', 'an', 'this', 'that', 'my', 'our', 'its'].includes(word.toLowerCase())) {
      const canonical = TOOLS_LOWER.get(word.toLowerCase());
      addEntity(canonical || word, 'tool');
    }
  }

  // People
  for (const m of text.matchAll(USERNAME_RE)) {
    addEntity(m[1], 'person');
  }
  for (const m of text.matchAll(NAME_SAID_RE)) {
    addEntity(m[1], 'person');
  }

  // Concepts — only hyphenated or multi-word terms (e.g., "microservices architecture")
  for (const m of text.matchAll(CONCEPT_BEFORE_RE)) {
    const concept = m[1].toLowerCase();
    if (concept.length > 4) {
      addEntity(concept, 'concept');
    }
  }
  for (const m of text.matchAll(CONCEPT_RE)) {
    const concept = m[1].trim().toLowerCase();
    if (concept.length > 4) {
      addEntity(concept, 'concept');
    }
  }

  // --- Triple extraction ---

  const triples: ExtractedTriple[] = [];
  const tripleSet = new Set<string>();

  function addTriple(subject: string, predicate: string, object: string): void {
    subject = cleanupRelationEndpoint(subject, predicate, 'subject');
    object = cleanupRelationEndpoint(object, predicate, 'object');
    if (!subject || !object) return;
    const objects = predicate === 'waiting_on'
      ? object.split(/\s+\band\b\s+/i).map(part => normalizePhrase(part)).filter(Boolean)
      : [object];

    for (const normalizedObject of objects) {
      const key = `${subject}|${predicate}|${normalizedObject}`;
      if (!tripleSet.has(key)) {
        tripleSet.add(key);
        triples.push({ subject, predicate, object: normalizedObject });
        // Ensure referenced entities exist
        ensureEntity(subject);
        ensureEntity(normalizedObject);
      }
    }
  }

  function ensureEntity(name: string): void {
    name = normalizePhrase(name);
    if (!name) return;
    if (STOPWORDS.has(name.toLowerCase())) return;
    // Check if any entity with this name exists
    for (const [key] of entityMap) {
      if (key.startsWith(name + '::')) return;
    }
    // Guess type for relation endpoints so extracted triples survive graph insertion.
    if (FILE_EXT_ENTITY_RE.test(name)) {
      addEntity(name, 'file');
    } else if (TOOLS_LOWER.has(name.toLowerCase())) {
      addEntity(TOOLS_LOWER.get(name.toLowerCase())!, 'tool');
    } else if (LANGUAGES_LOWER.has(name.toLowerCase())) {
      addEntity(LANGUAGES_LOWER.get(name.toLowerCase())!, 'language');
    } else if (/^(?:bertta|radi)\d+$/i.test(name)) {
      addEntity(name, 'service');
    } else if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(name)) {
      addEntity(name, 'person');
    } else if (/\b(?:api|server|service|plugin|framework|library|database)\b/i.test(name)) {
      addEntity(name, 'service');
    } else if (/_|-|\d/.test(name)) {
      addEntity(name, 'concept');
    }
  }

  function isKnownEntity(name: string): boolean {
    if (STOPWORDS.has(name.toLowerCase())) return false;
    for (const [key] of entityMap) {
      if (key.startsWith(name + '::') || key.toLowerCase().startsWith(name.toLowerCase() + '::')) return true;
    }
    return TOOLS_LOWER.has(name.toLowerCase()) || LANGUAGES_LOWER.has(name.toLowerCase());
  }

  function normalizePhrase(value: string): string {
    const normalized = value
      .trim()
      .replace(/^[\s,.;:()"'`-]+|[\s,.;:()"'`-]+$/g, '')
      .replace(LEADING_HEDGE_RE, '')
      .replace(REPORTING_PREFIX_RE, '')
      .replace(TRAILING_HELPER_RE, '')
      .replace(/\s+/g, ' ');
    const alias = ENTITY_ALIASES.get(normalized.toLowerCase());
    return alias ? alias.name : normalized;
  }

  function stripFillerPrefix(value: string): string {
    let current = value;
    const fillerPrefixRe = /^(?:(?:i\s+think|i\s+guess|i\s+believe|i\s+suspect|maybe|probably|possibly|not\s+sure|sort\s+of|kind\s+of|looks\s+like|seems\s+like|we\s+think|for\s+now|as\s+far\s+as\s+i\s+know|to\s+me)\b[\s,;:-]*)+/i;
    while (true) {
      const next = current.replace(fillerPrefixRe, '').trim();
      if (next === current) break;
      current = next;
    }
    return current;
  }

  function cleanupRelationEndpoint(value: string, predicate: string, role: 'subject' | 'object'): string {
    let cleaned = normalizePhrase(value);
    cleaned = stripFillerPrefix(cleaned);

    if (predicate === 'waiting_on') {
      if (role === 'subject') {
        cleaned = cleaned.replace(
          /^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|[\w./-]+)\s+(?:says|said|mentions?|mentioned|notes?|noted|asks?|asked|proposes?|proposed|thinks|thought|believes?|believed)\s+/i,
          ''
        );
        cleaned = stripFillerPrefix(cleaned);
        cleaned = cleaned.replace(/\s+(?:is|are|was|were)\b(?:\s+.*)?$/i, '').trim();
      } else {
        cleaned = cleaned.split(/\s+(?:for|because|since|so|before|after|until|when|while|if|to|via|about|around)\b/i)[0];
      }
    }

    return normalizePhrase(cleaned);
  }

  const relationSegments = [
    ...(title ? [title] : []),
    ...(content ? content.split(/\n+|(?<=[.!?])\s+/).map(segment => segment.trim()).filter(Boolean) : []),
  ];

  function extractRelations(re: RegExp, handler: (match: RegExpMatchArray) => void): void {
    for (const segment of relationSegments) {
      for (const match of segment.matchAll(re)) {
        handler(match);
      }
    }
  }

  // "using X for Y" → X uses Y
  extractRelations(new RegExp(`\\busing\\s+${REL_ENTITY_RE}\\s+for\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'uses', m[2]);
  });

  // "X uses Y"
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+uses\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'uses', m[2]);
  });

  // "replaced X with Y" → Y replaces X
  extractRelations(new RegExp(`\\breplaced\\s+${REL_ENTITY_RE}\\s+with\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[2], 'replaces', m[1]);
  });

  // "X depends on Y"
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+depends\\s+on\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'depends_on', m[2]);
  });

  // "X blocked by Y"
  extractRelations(/\b([\w-]+(?:\s+[\w-]+){0,4}?\s+rollout)(?:\s+on\s+(?:bertta|radi)\d+)?\s+blocked\s+by\s+(.+?)\s*$/gi, m => {
    addTriple(m[1], 'blocked_by', m[2]);
  });
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+blocked\\s+by\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'blocked_by', m[2]);
  });

  // "X deployed to Y"
  extractRelations(
    /(?:^|\s)([\w./-]+\.[A-Za-z0-9]+)\s+deployed\s+to\s+(.+?)(?=\s+(?:but|because|before|after|until|when|while)\b|[.!?]|$)/gi,
    m => {
      for (const target of m[2].split(/\s*(?:,|\band\b)\s*/i)) {
        addTriple(m[1], 'deployed_to', target);
      }
    }
  );
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+deployed\\s+to\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'deployed_to', m[2]);
  });

  // "X is waiting on Y" / "X waiting on Y"
  extractRelations(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+is\s+waiting\s+on\s+(.+?)(?=\s+(?:before|after|until|when)\b|$)/g, m => {
    addTriple(m[1], 'waiting_on', m[2]);
  });
  extractRelations(/\b((?:bertta|radi)\d+|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is\s+)?waiting\s+on\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?=\s+for\b|\s+(?:before|after|until|when)\b|$)/g, m => {
    addTriple(m[1], 'waiting_on', m[2]);
  });
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+(?:is\\s+)?waiting\\s+on\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'waiting_on', m[2]);
  });

  // "fixed X by Y" — only if X or Y are known entities
  extractRelations(new RegExp(`\\bfixed\\s+${REL_ENTITY_RE}\\s+by\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    if (isKnownEntity(m[1]) || isKnownEntity(m[2])) {
      addTriple(m[2], 'fixes', m[1]);
    }
  });

  // "chose X over Y"
  extractRelations(new RegExp(`\\bchose\\s+${REL_ENTITY_RE}\\s+over\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple('project', 'prefers', m[1]);
    addTriple('project', 'avoids', m[2]);
  });

  // "X configured with Y"
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+configured\\s+with\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'configures', m[2]);
  });

  // "implemented X" — only if X is a known entity
  for (const m of text.matchAll(/\bimplemented\s+(\w+)\b/gi)) {
    const word = m[1];
    if (isKnownEntity(word)) {
      addTriple('project', 'implements', word);
    }
  }

  // "X extends Y"
  extractRelations(new RegExp(`\\b${REL_ENTITY_RE}\\s+extends\\s+${REL_ENTITY_RE}\\b`, 'gi'), m => {
    addTriple(m[1], 'extends', m[2]);
  });

  const entities = Array.from(entityMap.values()).filter(entity => {
    if (entity.type !== 'tool' || entity.name.includes(' ')) return true;

    const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isAcronymOfService = Array.from(entityMap.values()).some(other =>
      other.type === 'service' &&
      other.name
        .split(/\s+/)
        .filter(part => !SERVICE_SUFFIX_WORDS.has(part.toLowerCase()))
        .map(part => part[0])
        .join('')
        .toLowerCase() === entity.name.toLowerCase()
    );
    if (isAcronymOfService) return false;

    return !Array.from(entityMap.values()).some(other =>
      other.type === 'service' &&
      new RegExp(`\\b\\w+\\s+${escaped}\\s+(?:API|server|service|plugin|framework|library|database)\\b`, 'i').test(other.name)
    );
  });

  return {
    entities,
    triples,
  };
}

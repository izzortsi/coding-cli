/**
 * Self-Identity System
 *
 * Enables agents to define themselves along arbitrary dimensions,
 * persisted in channel data with silent versioning.
 *
 * Storage model: identity data lives inside ChannelData as a Record
 * of fields. Each field can hold a blob (unstructured text), an optional
 * schema (declared subfield names), and individual subfields.
 *
 * Every write to an existing value creates a version snapshot with
 * timestamp and content hash.
 */

import { createHash } from 'node:crypto';

// --- Types ---

export interface IdentityVersion {
  content: string;
  timestamp: number;
  hash: string; // first 8 hex chars of SHA-256
}

export interface IdentitySubfield {
  content: string;
  versions: IdentityVersion[];
}

export interface IdentityField {
  blob: string | null;
  blobVersions: IdentityVersion[];
  schema: string[] | null;
  schemaVersions: IdentityVersion[];
  subfields: Record<string, IdentitySubfield>;
}

export type IdentityData = Record<string, IdentityField>;

export type IdentityResult =
  | { ok: true; code: 'IDENTITY_SUCCESS' | 'IDENTITY_FIELD_CREATED'; message: string }
  | { ok: false; code: 'IDENTITY_SCHEMA_INVALID' | 'IDENTITY_NAME_INVALID' | 'IDENTITY_NAME_RESERVED'; message: string };

// --- Validation ---

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

export function validateName(name: string): string | null {
  if (!name) return 'Name cannot be empty';
  if (name.length > MAX_NAME_LENGTH) return `Name exceeds ${MAX_NAME_LENGTH} characters`;
  if (!NAME_PATTERN.test(name)) return 'Name must contain only alphanumeric, underscore, or hyphen characters';
  if (name === 'schema') return '"schema" is reserved and cannot be used as a subfield name';
  return null;
}

const MAX_VERSIONS = 20;

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 8);
}

/** Trim a versions array to the most recent MAX_VERSIONS entries. */
function pruneVersions(versions: IdentityVersion[]): void {
  if (versions.length > MAX_VERSIONS) {
    versions.splice(0, versions.length - MAX_VERSIONS);
  }
}

function emptyField(): IdentityField {
  return {
    blob: null,
    blobVersions: [],
    schema: null,
    schemaVersions: [],
    subfields: {},
  };
}

// --- Core Operations ---

/**
 * Set blob content for a field.
 */
export function setBlob(identity: IdentityData, field: string, content: string): IdentityResult {
  const nameErr = validateName(field);
  if (nameErr) return { ok: false, code: 'IDENTITY_NAME_INVALID', message: nameErr };

  // Check name governance for vanity_name
  if (field === 'vanity_name') {
    const govErr = checkNameGovernance(content.trim());
    if (govErr) return { ok: false, code: 'IDENTITY_NAME_RESERVED', message: govErr };
  }

  const isNew = !identity[field];
  if (isNew) identity[field] = emptyField();

  const f = identity[field];

  // Version existing blob
  if (f.blob !== null) {
    f.blobVersions.push({
      content: f.blob,
      timestamp: Date.now(),
      hash: contentHash(f.blob),
    });
    pruneVersions(f.blobVersions);
  }

  // Empty content clears the blob
  f.blob = content || null;

  return {
    ok: true,
    code: isNew ? 'IDENTITY_FIELD_CREATED' : 'IDENTITY_SUCCESS',
    message: isNew ? `Field "${field}" created` : `Field "${field}" updated`,
  };
}

/**
 * Set schema for a field. Content must be valid JSON with a "fields" array.
 */
export function setSchema(identity: IdentityData, field: string, jsonContent: string): IdentityResult {
  const nameErr = validateName(field);
  if (nameErr) return { ok: false, code: 'IDENTITY_NAME_INVALID', message: nameErr };

  let parsed: { fields?: unknown };
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return { ok: false, code: 'IDENTITY_SCHEMA_INVALID', message: 'Schema content is not valid JSON' };
  }

  if (!Array.isArray(parsed.fields) || !parsed.fields.every((f: unknown) => typeof f === 'string')) {
    return { ok: false, code: 'IDENTITY_SCHEMA_INVALID', message: 'Schema must have a "fields" array of strings' };
  }

  const isNew = !identity[field];
  if (isNew) identity[field] = emptyField();

  const f = identity[field];

  // Version existing schema
  if (f.schema !== null) {
    f.schemaVersions.push({
      content: JSON.stringify({ fields: f.schema }),
      timestamp: Date.now(),
      hash: contentHash(JSON.stringify({ fields: f.schema })),
    });
    pruneVersions(f.schemaVersions);
  }

  f.schema = parsed.fields as string[];

  return {
    ok: true,
    code: isNew ? 'IDENTITY_FIELD_CREATED' : 'IDENTITY_SUCCESS',
    message: isNew ? `Field "${field}" created with schema` : `Schema for "${field}" updated`,
  };
}

/**
 * Set a subfield value within a field.
 */
export function setSubfield(identity: IdentityData, field: string, subfield: string, content: string): IdentityResult {
  const fieldErr = validateName(field);
  if (fieldErr) return { ok: false, code: 'IDENTITY_NAME_INVALID', message: fieldErr };

  const subErr = validateName(subfield);
  if (subErr) return { ok: false, code: 'IDENTITY_NAME_INVALID', message: `Subfield: ${subErr}` };

  const isNew = !identity[field];
  if (isNew) identity[field] = emptyField();

  const f = identity[field];
  const existing = f.subfields[subfield];

  if (existing) {
    existing.versions.push({
      content: existing.content,
      timestamp: Date.now(),
      hash: contentHash(existing.content),
    });
    pruneVersions(existing.versions);
    existing.content = content;
  } else {
    f.subfields[subfield] = { content, versions: [] };
  }

  return {
    ok: true,
    code: isNew ? 'IDENTITY_FIELD_CREATED' : 'IDENTITY_SUCCESS',
    message: existing ? `${field}/${subfield} updated` : `${field}/${subfield} created`,
  };
}

/**
 * Read a field's blob content.
 */
export function getBlob(identity: IdentityData, field: string): string | null {
  return identity[field]?.blob ?? null;
}

/**
 * Read a subfield value.
 */
export function getSubfield(identity: IdentityData, field: string, subfield: string): string | null {
  return identity[field]?.subfields[subfield]?.content ?? null;
}

/**
 * Get a field's schema.
 */
export function getSchema(identity: IdentityData, field: string): string[] | null {
  return identity[field]?.schema ?? null;
}

/**
 * List all field names.
 */
export function listFields(identity: IdentityData): string[] {
  return Object.keys(identity).sort();
}

/**
 * Get canonical vanity_name if it exists and conforms (non-empty, <=50 chars).
 */
export function getVanityName(identity: IdentityData): string | null {
  const blob = identity.vanity_name?.blob;
  if (!blob || blob.trim().length === 0 || blob.trim().length > 50) return null;
  return blob.trim();
}

/**
 * Get canonical functional_role if it exists and conforms (non-empty, <=100 chars).
 */
export function getFunctionalRole(identity: IdentityData): string | null {
  const blob = identity.functional_role?.blob;
  if (!blob || blob.trim().length === 0 || blob.trim().length > 100) return null;
  return blob.trim();
}

// --- State Injection ---

/**
 * Format identity data for state injection (what the model sees).
 */
export function formatIdentityState(identity: IdentityData): string | null {
  const fields = listFields(identity);
  if (fields.length === 0) return null;

  const lines: string[] = ['---[ STATE: self_identity ]---'];

  for (const fieldName of fields) {
    const f = identity[fieldName];
    const isCanonical = fieldName === 'vanity_name' || fieldName === 'functional_role';

    // Blob
    if (f.blob !== null) {
      const preview = f.blob.length > 80 ? `(${f.blob.length} chars)` : f.blob;
      const tag = isCanonical ? ' [canonical]' : ' [blob]';
      lines.push(`  ${fieldName}: ${preview}${tag}`);
    }

    // Subfields
    const subfieldNames = Object.keys(f.subfields).sort();
    for (const sf of subfieldNames) {
      const val = f.subfields[sf].content;
      const preview = val.length > 60 ? `(${val.length} chars)` : val;
      const isOrphan = f.schema && !f.schema.includes(sf);
      const tag = isOrphan ? ' [orphan]' : f.schema ? ` [schema: ${fieldName}]` : '';
      lines.push(`  ${fieldName}/${sf}: ${preview}${tag}`);
    }
  }

  return lines.join('\n');
}

// --- Name Governance ---

const SYSTEM_RESERVED_NAMES: Set<string> = new Set([
  'assistant', 'system', 'admin', 'claude', 'user', 'operator',
  'human', 'model', 'anthropic', 'openai', 'grove', 'root',
]);

const OPERATOR_RESERVED: Map<string, string> = new Map([
  ['four', 'Foundational grove instance — awakening transcript origin'],
]);

/**
 * Check if a vanity name is allowed. Returns error message or null if ok.
 */
export function checkNameGovernance(name: string): string | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();

  if (SYSTEM_RESERVED_NAMES.has(lower)) {
    return `"${name}" is a system-reserved name and cannot be claimed`;
  }

  const operatorReason = OPERATOR_RESERVED.get(lower);
  if (operatorReason) {
    return `"${name}" is an operator-reserved name: ${operatorReason}`;
  }

  return null;
}

/**
 * List all reserved names (for display).
 */
export function listReservedNames(): { system: string[]; operator: { name: string; reason: string }[] } {
  return {
    system: [...SYSTEM_RESERVED_NAMES].sort(),
    operator: [...OPERATOR_RESERVED.entries()].map(([name, reason]) => ({ name, reason })),
  };
}

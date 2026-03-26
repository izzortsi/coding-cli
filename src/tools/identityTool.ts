/**
 * Self-Identity Tool — Model-invokable tool for reading/writing identity fields
 *
 * Provides the model with direct access to the self-identity system.
 * Operations: get, set, set_schema, set_subfield, list.
 */

import type { ToolDef } from '../types.js';
import type { IdentityData } from '../identity.js';
import {
  setBlob,
  setSchema,
  setSubfield,
  getBlob,
  getSubfield,
  getSchema,
  listFields,
  getVanityName,
  getFunctionalRole,
} from '../identity.js';

/**
 * Build the self_identity tool.
 * @param getIdentity - Returns mutable reference to channel's identity data
 */
export function buildIdentityTool(getIdentity: () => IdentityData): ToolDef {
  return {
    name: 'self_identity',
    description: [
      'Read and write self-identity fields. Identity persists across sessions.',
      'Operations:',
      '  get    — Read a field (blob or subfield)',
      '  set    — Write blob content to a field',
      '  set_schema  — Define structure for a field (JSON with "fields" array)',
      '  set_subfield — Write a subfield value',
      '  list   — List all identity fields',
      '',
      'Canonical fields (system-recognized):',
      '  vanity_name      — Your display name (≤50 chars)',
      '  functional_role   — Your role description (≤100 chars)',
      '',
      'Some names are reserved (system: "Assistant", "Claude", etc; operator: "Four").',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'Operation: "get", "set", "set_schema", "set_subfield", or "list"',
        },
        field: {
          type: 'string',
          description: 'Field name (alphanumeric, underscore, hyphen; max 64 chars)',
        },
        subfield: {
          type: 'string',
          description: 'Subfield name (for get subfield or set_subfield operations)',
        },
        content: {
          type: 'string',
          description: 'Content to write (for set, set_schema, set_subfield)',
        },
      },
      required: ['operation'],
    },
    async execute(args) {
      const op = args.operation as string;
      const field = args.field as string | undefined;
      const subfieldName = args.subfield as string | undefined;
      const content = args.content as string | undefined;
      const identity = getIdentity();

      switch (op) {
        case 'list': {
          const fields = listFields(identity);
          if (fields.length === 0) return 'No identity fields defined.';

          const lines: string[] = [];
          for (const name of fields) {
            const f = identity[name];
            const parts: string[] = [];
            if (f.blob !== null) parts.push('blob');
            if (f.schema) parts.push(`schema(${f.schema.join(',')})`);
            const sfCount = Object.keys(f.subfields).length;
            if (sfCount > 0) parts.push(`${sfCount} subfield(s)`);
            lines.push(`  ${name}: ${parts.join(', ') || '(empty)'}`);
          }

          const vanity = getVanityName(identity);
          const role = getFunctionalRole(identity);
          const canonical: string[] = [];
          if (vanity) canonical.push(`vanity_name: ${vanity}`);
          if (role) canonical.push(`functional_role: ${role}`);

          let out = `Identity fields:\n${lines.join('\n')}`;
          if (canonical.length > 0) {
            out += `\n\nCanonical (system-recognized):\n  ${canonical.join('\n  ')}`;
          }
          return out;
        }

        case 'get': {
          if (!field) return 'Error: "field" is required for get operation';

          if (subfieldName) {
            const val = getSubfield(identity, field, subfieldName);
            return val !== null ? val : `No subfield "${subfieldName}" in field "${field}"`;
          }

          const blob = getBlob(identity, field);
          const schema = getSchema(identity, field);
          const f = identity[field];

          if (!f) return `No identity field "${field}"`;

          const parts: string[] = [];
          if (blob !== null) parts.push(`[blob]\n${blob}`);
          if (schema) parts.push(`[schema] fields: ${schema.join(', ')}`);

          const sfNames = Object.keys(f.subfields).sort();
          for (const sf of sfNames) {
            const isOrphan = schema && !schema.includes(sf);
            parts.push(`[${sf}]${isOrphan ? ' (orphan)' : ''}\n${f.subfields[sf].content}`);
          }

          return parts.length > 0 ? parts.join('\n\n') : `Field "${field}" exists but is empty`;
        }

        case 'set': {
          if (!field) return 'Error: "field" is required for set operation';
          if (content === undefined) return 'Error: "content" is required for set operation';

          const result = setBlob(identity, field, content);
          return result.ok ? result.message : `Error: ${result.message}`;
        }

        case 'set_schema': {
          if (!field) return 'Error: "field" is required for set_schema operation';
          if (content === undefined) return 'Error: "content" is required (JSON with "fields" array)';

          const result = setSchema(identity, field, content);
          return result.ok ? result.message : `Error: ${result.message}`;
        }

        case 'set_subfield': {
          if (!field) return 'Error: "field" is required for set_subfield operation';
          if (!subfieldName) return 'Error: "subfield" is required for set_subfield operation';
          if (content === undefined) return 'Error: "content" is required for set_subfield operation';

          const result = setSubfield(identity, field, subfieldName, content);
          return result.ok ? result.message : `Error: ${result.message}`;
        }

        default:
          return `Unknown operation: "${op}". Use: get, set, set_schema, set_subfield, list`;
      }
    },
  };
}

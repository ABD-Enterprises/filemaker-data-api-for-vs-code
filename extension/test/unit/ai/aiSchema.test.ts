import { describe, expect, it } from 'vitest';

import { AiInputError, validateInput, type JsonSchema } from '../../../src/ai/aiSchema';
import { AI_TOOL_DEFINITIONS } from '../../../src/ai/aiToolDefinitions';

function everyObjectSchema(schema: JsonSchema, path: string, visit: (schema: JsonSchema, path: string) => void): void {
  if (schema.type === 'object') {
    visit(schema, path);
    for (const [key, child] of Object.entries(schema.properties ?? {})) everyObjectSchema(child, `${path}.${key}`, visit);
    if (typeof schema.additionalProperties === 'object') everyObjectSchema(schema.additionalProperties, `${path}[]`, visit);
  }
  if (schema.items) everyObjectSchema(schema.items, `${path}[]`, visit);
}

describe('tool input schemas', () => {
  it('forbid additional properties on every object that has named properties', () => {
    for (const tool of AI_TOOL_DEFINITIONS) {
      everyObjectSchema(tool.inputSchema, tool.name, (schema, path) => {
        // A map (field name -> value) is closed by a value schema and a size cap instead.
        if (typeof schema.additionalProperties !== 'object') {
          expect(schema.additionalProperties, path).toBe(false);
        } else {
          expect(typeof schema.additionalProperties === 'object', path).toBe(true);
          expect(schema.maxProperties, path).toBeGreaterThan(0);
        }
      });
    }
  });

  it('use names of the form verb_noun', () => {
    for (const tool of AI_TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^fm_[a-z]+_[a-z]+$/);
    }
  });

  it('have unique names and reference names', () => {
    expect(new Set(AI_TOOL_DEFINITIONS.map((tool) => tool.name)).size).toBe(AI_TOOL_DEFINITIONS.length);
    expect(new Set(AI_TOOL_DEFINITIONS.map((tool) => tool.toolReferenceName)).size).toBe(AI_TOOL_DEFINITIONS.length);
  });
});

describe('validateInput', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: 3 }, s: { type: 'string', maxLength: 3 }, list: { type: 'array', maxItems: 1, items: { type: 'string' } } },
    required: ['n'],
    additionalProperties: false
  };

  it('accepts valid input and rejects each kind of violation', () => {
    expect(() => validateInput(schema, { n: 2, s: 'abc', list: ['x'] })).not.toThrow();
    for (const bad of [{}, { n: 0 }, { n: 4 }, { n: 1.5 }, { n: '1' }, { n: 1, s: 'abcd' }, { n: 1, list: ['a', 'b'] }, { n: 1, x: 1 }, null, [], 'x', { n: NaN }]) {
      expect(() => validateInput(schema, bad), JSON.stringify(bad)).toThrow(AiInputError);
    }
  });

  it('does not treat prototype keys as declared properties', () => {
    const input = JSON.parse('{"n":1,"__proto__":{"n":2},"constructor":1}');
    expect(() => validateInput(schema, input)).toThrow(AiInputError);
  });

  it('rejects an unsupported schema keyword type loudly instead of passing', () => {
    expect(() => validateInput({ type: undefined } as JsonSchema, 1)).toThrow(/Unsupported schema/);
  });
});

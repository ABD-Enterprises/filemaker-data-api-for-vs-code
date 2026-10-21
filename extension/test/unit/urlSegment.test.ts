import { describe, expect, it } from 'vitest';

import { AiToolError } from '../../src/ai/aiToolService';
import { FMClientError } from '../../src/services/errors';
import { SnippetError } from '../../src/snippets/model';
import { assertNameProvided, assertUsableUrlName } from '../../src/utils/urlSegment';

describe('shared name guards preserve caller messages and errors', () => {
  // Literal messages captured from the callers before consolidation.
  it.each([
    ['Script Runner script', 'Script name is required.', FMClientError],
    ['Script Runner layout', 'Layout is required.', FMClientError],
    ['snippet script', 'Script name is required.', SnippetError],
    ['snippet layout', 'Layout is required.', SnippetError],
    ['snippet field', 'Container field name is required.', SnippetError]
  ] as const)('%s: blank-name message is exact', (_caller, message, ErrorType) => {
    for (const name of [undefined, '', ' ', '   ', '\t\r\n', '\u00a0\ufeff']) {
      const check = () => assertNameProvided(name, message, (text) => new ErrorType(text));
      expect(check).toThrowError(ErrorType);
      expect(check).toThrowError(new ErrorType(message));
    }
  });

  it('uses FMClientError by default for Script Runner and future client adoption', () => {
    expect(() => assertNameProvided('', 'Layout is required.')).toThrowError(new FMClientError('Layout is required.'));
  });

  it.each([
    ['Script Runner script', 'script', FMClientError],
    ['Script Runner layout', 'layout', FMClientError],
    ['AI script', 'script', AiToolError],
    ['AI layout', 'layout', AiToolError],
    ['snippet script', 'script', SnippetError],
    ['snippet layout', 'layout', SnippetError],
    ['snippet field', 'field', SnippetError]
  ] as const)('%s: dot-name message is exact', (_caller, kind, ErrorType) => {
    for (const name of ['.', '..']) {
      const message = `The ${kind} name "${name}" cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.`;
      const check = () => assertUsableUrlName(name, kind, (text) => new ErrorType(text));
      expect(check).toThrowError(ErrorType);
      expect(check).toThrowError(new ErrorType(message));
    }
  });

  it('keeps the default client dot-error metadata', () => {
    try {
      assertUsableUrlName('..', 'layout');
      expect.unreachable('a dot segment must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(FMClientError);
      expect(error).toMatchObject({ code: 'NAME_NOT_USABLE_IN_URL', kind: 'validation', isRetryable: false });
    }
  });

  it.each([' Sales ', ' Echo', ' Photo ', ' . ', ' .. ', 'Q1..Q2', 'a/b', 'é'])('accepts the exact name %j', (name) => {
    expect(() => assertNameProvided(name, 'required')).not.toThrow();
    expect(() => assertUsableUrlName(name, 'layout')).not.toThrow();
  });
});

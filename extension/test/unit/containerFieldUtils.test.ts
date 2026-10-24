import { describe, it, expect } from 'vitest';

import {
  isContainerField,
  resolveContainerUrl,
  isImageContainer
} from '../../src/utils/containerFieldUtils';

describe('isContainerField', () => {
  it('returns true for result type "container"', () => {
    expect(isContainerField({ name: 'Photo', result: 'container' })).toBe(true);
  });

  it('returns true for type "container"', () => {
    expect(isContainerField({ name: 'File', type: 'container' })).toBe(true);
  });

  it('returns true for result containing "container"', () => {
    expect(isContainerField({ name: 'Doc', result: 'Container Field' })).toBe(true);
  });

  it('returns false for text fields', () => {
    expect(isContainerField({ name: 'Name', result: 'text', type: 'normal' })).toBe(false);
  });

  it('returns false for number fields', () => {
    expect(isContainerField({ name: 'Amount', result: 'number' })).toBe(false);
  });

  it('returns false when no type info', () => {
    expect(isContainerField({ name: 'Unknown' })).toBe(false);
  });
});

describe('resolveContainerUrl', () => {
  it('returns full URL when value is already absolute', () => {
    expect(resolveContainerUrl('https://fm.test', 'https://cdn.test/file.pdf')).toBe(
      'https://cdn.test/file.pdf'
    );
  });

  it('prepends server URL to relative path', () => {
    expect(resolveContainerUrl('https://fm.test', '/Streaming_SSL/MainDB/abc123')).toBe(
      'https://fm.test/Streaming_SSL/MainDB/abc123'
    );
  });

  it('handles server URL with trailing slash', () => {
    expect(resolveContainerUrl('https://fm.test/', '/path/to/file')).toBe(
      'https://fm.test/path/to/file'
    );
  });

  it('handles relative path without leading slash', () => {
    expect(resolveContainerUrl('https://fm.test', 'path/to/file')).toBe(
      'https://fm.test/path/to/file'
    );
  });

  it('returns undefined for empty string', () => {
    expect(resolveContainerUrl('https://fm.test', '')).toBeUndefined();
  });

  it('returns undefined for non-string value', () => {
    expect(resolveContainerUrl('https://fm.test', null)).toBeUndefined();
    expect(resolveContainerUrl('https://fm.test', 42)).toBeUndefined();
  });
});

describe('isImageContainer', () => {
  it('detects common image extensions', () => {
    expect(isImageContainer('/path/photo.jpg')).toBe(true);
    expect(isImageContainer('/path/photo.jpeg')).toBe(true);
    expect(isImageContainer('/path/photo.png')).toBe(true);
    expect(isImageContainer('/path/photo.gif')).toBe(true);
    expect(isImageContainer('/path/photo.webp')).toBe(true);
    expect(isImageContainer('/path/photo.svg')).toBe(true);
  });

  it('handles URLs with query strings', () => {
    expect(isImageContainer('/path/photo.jpg?token=abc')).toBe(true);
  });

  it('returns false for non-image extensions', () => {
    expect(isImageContainer('/path/doc.pdf')).toBe(false);
    expect(isImageContainer('/path/data.csv')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isImageContainer('/path/PHOTO.JPG')).toBe(true);
    expect(isImageContainer('/path/Photo.PNG')).toBe(true);
  });
});

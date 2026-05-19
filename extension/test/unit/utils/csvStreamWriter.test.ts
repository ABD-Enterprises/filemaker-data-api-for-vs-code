import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCsvStreamWriter } from '../../../src/utils/csvStreamWriter';

describe('createCsvStreamWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csv-stream-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers columns from the first row and writes header + data', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ recordId: '1', name: 'Alice', age: 30 });
    await writer.append({ recordId: '2', name: 'Bob', age: 25 });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('recordId,name,age\n1,Alice,30\n2,Bob,25\n');
  });

  it('respects explicit columns option and writes header eagerly', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file, { columns: ['a', 'b'] });
    await writer.append({ b: 2, a: 1, c: 99 }); // c is dropped, order is a then b
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b\n1,2\n');
  });

  it('drops fields not present in the discovered column set on later rows', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1, b: 2 });
    await writer.append({ a: 10, b: 20, c: 'extra' }); // c is dropped
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b\n1,2\n10,20\n');
  });

  it('escapes commas, quotes, and newlines inside cells', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ name: 'Doe, John', note: 'quote: "hi"', body: 'line1\nline2' });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe(
      'name,note,body\n"Doe, John","quote: ""hi""","line1\nline2"\n'
    );
  });

  it('produces an empty file when no rows are written and no columns preset', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('');
  });

  it('handles undefined and null cell values as empty strings', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1, b: null, c: undefined });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b,c\n1,,\n');
  });

  it('supports CRLF line endings', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file, { lineEnding: '\r\n' });
    await writer.append({ a: 1, b: 2 });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b\r\n1,2\r\n');
  });

  it('close() is idempotent', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1 });
    await writer.close();
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a\n1\n');
  });

  it('does not hold all rows in memory (smoke test with 5k rows)', async () => {
    const file = join(dir, 'big.csv');
    const writer = await createCsvStreamWriter(file);
    for (let i = 0; i < 5000; i += 1) {
      await writer.append({ id: i, label: `row-${i}` });
    }
    await writer.close();
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('id,label');
    expect(lines[1]).toBe('0,row-0');
    expect(lines[5000]).toBe('4999,row-4999');
  });
});

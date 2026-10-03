import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../src/server.js';

test('recognizes an ESM entry path containing spaces', () => {
  const entryPath = path.resolve('folder with spaces', 'server.js');
  assert.equal(isEntrypoint(pathToFileURL(entryPath).href, entryPath), true);
  assert.equal(isEntrypoint(pathToFileURL(entryPath).href, `${entryPath}.other`), false);
});

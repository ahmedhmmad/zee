import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitStatements, isNonTransactional, unwrapTransaction } from '../scripts/sql-split.ts';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

test('splits plain statements on the semicolon', () => {
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
});

test('keeps a trailing statement that has no terminating semicolon', () => {
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('a semicolon inside a string literal is not a boundary', () => {
  assert.deepEqual(splitStatements("SELECT 'a;b'; SELECT 2;"), ["SELECT 'a;b'", 'SELECT 2']);
});

test("'' inside a literal does not end it", () => {
  assert.deepEqual(splitStatements("SELECT 'it''s; fine'; SELECT 2;"), ["SELECT 'it''s; fine'", 'SELECT 2']);
});

test('a semicolon inside a line comment is not a boundary', () => {
  assert.deepEqual(splitStatements('SELECT 1 -- a; comment\n; SELECT 2;'), ['SELECT 1 -- a; comment', 'SELECT 2']);
});

test('a semicolon inside a block comment is not a boundary', () => {
  assert.deepEqual(splitStatements('SELECT 1 /* a; comment */; SELECT 2;'), ['SELECT 1 /* a; comment */', 'SELECT 2']);
});

test('block comments nest, as they do in Postgres', () => {
  assert.deepEqual(splitStatements('SELECT 1 /* a /* b; */ c; */; SELECT 2;'), ['SELECT 1 /* a /* b; */ c; */', 'SELECT 2']);
});

test('a dollar-quoted function body is one statement, semicolons and all', () => {
  const sql = `
    CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1;
      PERFORM 2;
    END;
    $$;
    SELECT 1;
  `;
  const out = splitStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0]!, /CREATE FUNCTION/);
  assert.match(out[0]!, /PERFORM 2;/);
  assert.equal(out[1], 'SELECT 1');
});

test('a tagged dollar quote is closed only by its own tag', () => {
  const sql = `SELECT $tag$ inner $$ still going; $tag$; SELECT 2;`;
  const out = splitStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0]!, /still going/);
});

test('a trailing comment is not emitted as a statement', () => {
  assert.deepEqual(splitStatements('SELECT 1;\n-- done\n'), ['SELECT 1']);
});

test('an empty file yields no statements', () => {
  assert.deepEqual(splitStatements('\n  \n-- nothing here\n'), []);
});

test('the no-transaction marker is recognised, and absent by default', () => {
  assert.equal(isNonTransactional('-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY x ON t (c);'), true);
  assert.equal(isNonTransactional('--migrate:no-transaction\n'), true);
  assert.equal(isNonTransactional('BEGIN;\nCREATE TABLE t ();\nCOMMIT;'), false);
});

test('unwrapTransaction strips a file-level BEGIN/COMMIT', () => {
  const { body, wasWrapped } = unwrapTransaction('BEGIN;\nCREATE TABLE t ();\nCOMMIT;');
  assert.equal(wasWrapped, true);
  assert.equal(body.includes('BEGIN'), false);
  assert.equal(body.includes('COMMIT'), false);
  assert.match(body, /CREATE TABLE t \(\)/);
});

test('unwrapTransaction leaves an unwrapped file alone', () => {
  const sql = 'CREATE TABLE t ();';
  const { body, wasWrapped } = unwrapTransaction(sql);
  assert.equal(wasWrapped, false);
  assert.equal(body, sql);
});

test('every migration in the repo splits and round-trips', async () => {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 0, 'expected migrations to exist');

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const statements = splitStatements(sql);
    assert.ok(statements.length > 0, `${file} produced no statements`);

    // Nothing may be lost: every statement has to carry real SQL, and no
    // statement may still contain an unterminated dollar quote.
    for (const s of statements) {
      assert.ok(s.trim().length > 0, `${file} produced an empty statement`);
      const dollars = (s.match(/\$\$/g) ?? []).length;
      assert.equal(dollars % 2, 0, `${file} split a dollar-quoted body: ${s.slice(0, 60)}`);
    }
  }
});

test('the repo convention holds: every migration wraps itself in a transaction', async () => {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    if (isNonTransactional(sql)) continue; // opted out, by design
    const { wasWrapped } = unwrapTransaction(sql);
    assert.equal(wasWrapped, true, `${file} does not wrap itself in BEGIN/COMMIT`);
  }
});

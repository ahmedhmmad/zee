/**
 * Split a migration file into individual statements.
 *
 * Only needed for migrations marked `-- migrate: no-transaction`. Postgres wraps
 * a multi-statement simple query in an *implicit* transaction, so a file
 * containing CREATE INDEX CONCURRENTLY fails with "cannot run inside a
 * transaction block" even when the file itself has no BEGIN/COMMIT. Sending each
 * statement as its own round trip is the only way to avoid that.
 *
 * Splitting SQL on `;` naively is wrong: semicolons appear inside string
 * literals, dollar-quoted function bodies, and comments. This tracks enough
 * lexical state to know when a semicolon is really a statement boundary.
 */

type State =
  | { kind: 'normal' }
  | { kind: 'line-comment' }
  | { kind: 'block-comment'; depth: number }
  | { kind: 'single-quote' }
  | { kind: 'dollar-quote'; tag: string };

/**
 * Read a dollar-quote tag at `i` (`$$` or `$tag$`), or null if this `$` does not
 * open one. Tags are letters, digits and underscores, and must not start with a
 * digit — matching Postgres's own rule.
 */
function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
  if (sql[j] !== '$') return null;
  const tag = sql.slice(i + 1, j);
  if (tag.length > 0 && /^[0-9]/.test(tag)) return null;
  return sql.slice(i, j + 1);
}

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let state: State = { kind: 'normal' };
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];

    switch (state.kind) {
      case 'normal': {
        if (c === '-' && next === '-') {
          state = { kind: 'line-comment' };
          i++;
        } else if (c === '/' && next === '*') {
          state = { kind: 'block-comment', depth: 1 };
          i++;
        } else if (c === "'") {
          state = { kind: 'single-quote' };
        } else if (c === '$') {
          const tag = dollarTagAt(sql, i);
          if (tag) {
            state = { kind: 'dollar-quote', tag };
            i += tag.length - 1;
          }
        } else if (c === ';') {
          const stmt = sql.slice(start, i).trim();
          if (stmt) out.push(stmt);
          start = i + 1;
        }
        break;
      }

      case 'line-comment': {
        if (c === '\n') state = { kind: 'normal' };
        break;
      }

      case 'block-comment': {
        // Postgres block comments nest, unlike C's.
        if (c === '/' && next === '*') {
          state = { kind: 'block-comment', depth: state.depth + 1 };
          i++;
        } else if (c === '*' && next === '/') {
          state = state.depth === 1 ? { kind: 'normal' } : { kind: 'block-comment', depth: state.depth - 1 };
          i++;
        }
        break;
      }

      case 'single-quote': {
        // '' is an escaped quote, not the end of the literal.
        if (c === "'" && next === "'") i++;
        else if (c === "'") state = { kind: 'normal' };
        break;
      }

      case 'dollar-quote': {
        if (c === '$' && sql.startsWith(state.tag, i)) {
          i += state.tag.length - 1;
          state = { kind: 'normal' };
        }
        break;
      }
    }
  }

  // Whatever follows the last semicolon, if it is not just trailing whitespace
  // or a comment.
  const tail = sql.slice(start).trim();
  if (tail && stripComments(tail).trim()) out.push(tail);

  return out;
}

/** Remove comments so a fragment can be tested for emptiness. */
function stripComments(sql: string): string {
  let out = '';
  let state: State = { kind: 'normal' };

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (state.kind === 'normal') {
      if (c === '-' && next === '-') {
        state = { kind: 'line-comment' };
        i++;
        continue;
      }
      if (c === '/' && next === '*') {
        state = { kind: 'block-comment', depth: 1 };
        i++;
        continue;
      }
      out += c;
      if (c === "'") state = { kind: 'single-quote' };
      continue;
    }

    if (state.kind === 'line-comment') {
      if (c === '\n') {
        state = { kind: 'normal' };
        out += c;
      }
      continue;
    }

    if (state.kind === 'block-comment') {
      if (c === '/' && next === '*') {
        state = { kind: 'block-comment', depth: state.depth + 1 };
        i++;
      } else if (c === '*' && next === '/') {
        state = state.depth === 1 ? { kind: 'normal' } : { kind: 'block-comment', depth: state.depth - 1 };
        i++;
      }
      continue;
    }

    if (state.kind === 'single-quote') {
      out += c;
      if (c === "'" && next === "'") {
        out += next;
        i++;
      } else if (c === "'") {
        state = { kind: 'normal' };
      }
      continue;
    }
  }

  return out;
}

/**
 * A migration marked `-- migrate: no-transaction` is sent one statement at a
 * time, because it contains something Postgres refuses to run inside a
 * transaction block — CREATE INDEX CONCURRENTLY, chiefly.
 */
export function isNonTransactional(sql: string): boolean {
  return /^[ \t]*--[ \t]*migrate:[ \t]*no-transaction[ \t]*$/im.test(sql);
}

/**
 * Strip a file's own outer BEGIN/COMMIT so the runner can wrap the body in a
 * transaction that also records the migration as applied. Returns the SQL
 * unchanged if it is not wrapped that way.
 *
 * Every migration in this repo opens with BEGIN and closes with COMMIT. Sending
 * that as-is means the file commits itself, and the row recording it lands in a
 * separate transaction — so a crash in between silently re-runs the migration
 * on the next start.
 */
export function unwrapTransaction(sql: string): { body: string; wasWrapped: boolean } {
  const statements = splitStatements(sql);

  // Statements keep their leading comments — every migration here opens with a
  // header block — so compare against the comment-stripped form.
  const bare = (s: string | undefined) => stripComments(s ?? '').trim().toUpperCase();
  const first = bare(statements[0]);
  const last = bare(statements[statements.length - 1]);

  if (statements.length >= 2 && first === 'BEGIN' && (last === 'COMMIT' || last === 'END')) {
    return { body: statements.slice(1, -1).join(';\n') + ';', wasWrapped: true };
  }
  return { body: sql, wasWrapped: false };
}

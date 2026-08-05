import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ONE READER FOR EVERY GUARD THAT ASSERTS OVER THE SOURCE.
 *
 * Three guards in this suite make claims about `src/` rather than about a value
 * — `fillpaths.test.ts` (coverage), `egress.test.ts` (egress) and
 * `lifetime.test.ts` (lifetime). Each of them used to carry its own little
 * scanner, and the fourth gate measured what that costs: two of the three
 * scanners enumerated the wrong unit and both of their guards passed a
 * genuinely new member of their own class (`docs/design/sink-closure-review-4.md`
 * §2 and §3). A second copy of a parser is the same failure this whole
 * programme is about — **a helper written for a sentence and wired to some of
 * the places the sentence applies** — so there is one parser and the guards
 * share it.
 *
 * WHAT IT DOES. `blank()` returns the file with every comment, string,
 * template and regular-expression literal replaced by spaces, **at the same
 * indices and with newlines preserved**. That single property is what makes
 * everything else honest:
 *
 *   · a call site inside a comment or a string is not a call site, so a guard
 *     can no longer be satisfied — or defeated — by prose;
 *   · braces inside strings cannot unbalance the structure, so "which function
 *     is this call in" is a question with an answer;
 *   · indices into the blanked text are indices into the real text, so a guard
 *     can find a call structurally and then read its NAME from the raw bytes.
 *
 * The previous generation of these files did the first job with a line filter
 * (`!t.startsWith('//')`), which drops a whole line for a trailing comment and
 * keeps every string literal. It never did the second or the third at all,
 * which is why both scanners fell back to splitting on a token
 * (`server.registerTool(`) that has nothing to do with the property being
 * asserted.
 *
 * WHAT IT CANNOT DO, stated because every guard in this repo states it. This is
 * a lexer, not a parser with a type checker behind it. It knows literals and
 * braces; it does not know scope, aliasing or types. So it can tell you that
 * `requestFill(` appears inside the body of a function that also names
 * `registerNeedles(`, and it cannot tell you that the values reaching one are
 * the values reaching the other. Where a guard needs more than this, the guard
 * says so at its own assertion rather than implying the reader has it.
 *
 * The one construct that can defeat the lexer is a regular-expression literal
 * whose `/` opening is misread as a division — see `regexCanStart`. It fails
 * CLOSED and loudly: a mis-lex unbalances the braces, the enclosing-function
 * lookup returns something absurd, and the frozen tables below it stop
 * matching. A guard that goes red because the reader got confused is a guard
 * asking to be looked at, which is the correct direction for this failure.
 */

export const ROOT = join(__dirname, '..', '..');

export function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, ext));
    else if (p.endsWith(ext) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

/**
 * Can a `/` at this point open a regular expression rather than divide?
 *
 * The standard lexical heuristic: a regex may start where a VALUE may start,
 * and division may only follow one. `prev` is the last significant character
 * and `word` the identifier immediately before it, so `return /x/` and
 * `typeof /x/` are regexes while `a / b` and `x.y / 2` are division.
 */
function regexCanStart(prev: string, word: string): boolean {
  if (prev === '') return true;
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
  return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await'].includes(word);
}

/** Where a quoted string starting at `i` ends (index of its closing quote). */
function endOfQuoted(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j;
    if (quote !== '`' && c === '\n') return j - 1;
    j += 1;
  }
  return src.length - 1;
}

/**
 * The file with every literal and comment turned to spaces, same length, same
 * newlines, same indices.
 *
 * Template literals are blanked whole, `${…}` interpolations included. The
 * interpolations are balanced expressions, so erasing them preserves brace
 * structure; and a call site that only appears inside a template is a string,
 * which is exactly what this function exists to stop a guard from counting.
 */
export function blank(src: string): string {
  const out = src.split('');
  const n = src.length;
  const erase = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  let prev = '';
  let word = '';

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1] ?? '';

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      erase(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      erase(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = endOfQuoted(src, i, c);
      erase(i + 1, end);
      i = end + 1;
      prev = c;
      word = '';
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '`') break;
        if (ch === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            const e = src[k];
            if (e === '{') depth += 1;
            else if (e === '}') depth -= 1;
            else if (e === "'" || e === '"' || e === '`') {
              k = endOfQuoted(src, k, e) + 1;
              continue;
            }
            k += 1;
          }
          j = k;
          continue;
        }
        j += 1;
      }
      erase(i + 1, j);
      i = Math.min(n, j + 1);
      prev = '`';
      word = '';
      continue;
    }
    if (c === '/' && regexCanStart(prev, word)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j + 1 < n && /[a-z]/.test(src[j + 1]!)) j += 1;
        erase(i + 1, j);
        i = j + 1;
        prev = '/';
        word = '';
        continue;
      }
    }

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j += 1;
      word = src.slice(i, j);
      prev = src[j - 1]!;
      i = j;
      continue;
    }
    prev = c;
    word = '';
    i += 1;
  }
  return out.join('');
}

/**
 * Every quoted string that is really a string in this file — not one inside a
 * comment, which `blank` has already erased.
 *
 * `blank` keeps the quote characters and erases what is between them, so the
 * next quote in the blanked text is always the true closer: escapes,
 * apostrophes and embedded quotes cannot fool it. The raw slice between the
 * two is the literal.
 */
export function stringLiterals(code: string, raw: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i += 1) {
    const q = code[i];
    if (q !== "'" && q !== '"') continue;
    const end = code.indexOf(q, i + 1);
    if (end === -1) break;
    out.push(raw.slice(i + 1, end));
    i = end;
  }
  return out;
}

export interface Source {
  /** Path relative to the repo root, forward slashes. */
  rel: string;
  /** The file exactly as it is on disk. */
  raw: string;
  /** The same file with literals and comments blanked, indices preserved. */
  code: string;
  /**
   * `code`, plus every real string literal re-quoted on its own line.
   *
   * For guards whose unit of interest IS a string — an event name, an IPC
   * channel — where matching the raw file would count a mention in a comment
   * and matching `code` would count nothing at all.
   */
  quoted: string;
}

let cached: Source[] | null = null;

/** Every `.ts` file under `src/`, read once per process. */
export function sources(): Source[] {
  if (cached) return cached;
  cached = filesUnder(join(ROOT, 'src'), '.ts').map((path) => {
    const raw = readFileSync(path, 'utf8');
    const code = blank(raw);
    return {
      rel: path.slice(ROOT.length + 1).replace(/\\/g, '/'),
      raw,
      code,
      quoted: `${code}\n${stringLiterals(code, raw)
        .map((s) => `'${s}'`)
        .join('\n')}`,
    };
  });
  return cached;
}

/** Every index at which `needle` occurs in real code (not in a literal). */
export function occurrences(code: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = code.indexOf(needle); i !== -1; i = code.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export interface EnclosingFunction {
  /** Index of the `{` that opens the body. */
  open: number;
  /** Index just past the `}` that closes it. */
  close: number;
  /** The blanked body, `{` to `}` inclusive. */
  body: string;
  /**
   * A name for this function that a human can find again: its declared
   * identifier, or — for an anonymous function handed to a call — the first
   * string argument of that call, which is how `server.registerTool('x', …, fn)`
   * names its handler.
   */
  name: string;
}

/**
 * The innermost FUNCTION whose body encloses `at`.
 *
 * The unit the coverage guard is actually about. A `registerTool` block is a
 * unit somebody chose; a function body is the unit a value flows through, and a
 * fill path written as a module-scope helper — the instance that walked past
 * the previous guard — lives in one of these and not in the other.
 *
 * Walks out through `if`/`for`/`while`/`switch`/`catch`/`try` blocks, object
 * literals and class bodies until it reaches a brace whose head is a function
 * head: `…) {`, `…): T {`, or `… => {`.
 */
export function enclosingFunction(code: string, raw: string, at: number): EnclosingFunction | null {
  let i = at;
  let depth = 0;
  while (i > 0) {
    i -= 1;
    const c = code[i];
    if (c === '}') {
      depth += 1;
      continue;
    }
    if (c !== '{') continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const head = headInfo(code, i);
    if (!head) continue;
    const close = matchBrace(code, i);
    return {
      open: i,
      close,
      body: code.slice(i, close),
      name: nameOf(code, raw, head),
    };
  }
  return null;
}

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

interface Head {
  /** Was the body introduced by `=>` rather than by a parameter list? */
  arrow: boolean;
  /** Index of the `(` opening the parameter list, or -1 for `x => {`. */
  paramOpen: number;
  /** Index of the `{` opening the body. */
  bodyOpen: number;
}

/**
 * Does the text before a `{` read as a function head rather than a block head,
 * and if so where does its parameter list start?
 *
 * The `if`/`for`/`while`/`switch`/`catch` exclusion is the whole subtlety:
 * those also end in `)`, and treating one as a function would make a guard's
 * "in the enclosing function" mean "in the enclosing if-branch", which is
 * narrower than the property and would pass a fill armed two lines above the
 * branch. Erring the other way — walking out too far — only ever makes a guard
 * more permissive about WHERE the arming sits, never about whether it exists.
 */
function headInfo(code: string, open: number): Head | null {
  let s = code.slice(0, open).replace(/\s+$/, '');
  if (s.endsWith('=>')) s = s.slice(0, -2).replace(/\s+$/, '');
  else {
    const annotated = /\)(\s*:\s*[^;{}()]*)$/.exec(s);
    if (annotated) s = s.slice(0, s.length - annotated[1]!.length).replace(/\s+$/, '');
    if (!s.endsWith(')')) return null;
  }
  const arrow = code.slice(0, open).replace(/\s+$/, '').endsWith('=>');
  if (arrow && !s.endsWith(')')) {
    // `x => {` — a single unparenthesised parameter.
    return /[A-Za-z0-9_$]$/.test(s) ? { arrow, paramOpen: -1, bodyOpen: open } : null;
  }
  let depth = 0;
  let i = s.length - 1;
  for (; i >= 0; i -= 1) {
    if (s[i] === ')') depth += 1;
    else if (s[i] === '(') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (i < 0) return null;
  if (!arrow && /\b(if|for|while|switch|catch)\s*$/.test(s.slice(0, i))) return null;
  return { arrow, paramOpen: i, bodyOpen: open };
}

/**
 * A durable name for the function whose body opens at `open`.
 *
 * Declared functions and methods answer with their identifier. An anonymous
 * function passed to a call answers with that call's first string argument,
 * read from the RAW text at an index the blanked text located — which is how
 * both of this codebase's fill paths get the names an author would use for
 * them (`vault_request_fill`, `browser_fill_form`) without any guard having to
 * know what `server.registerTool` is.
 */
function nameOf(code: string, raw: string, head: Head): string {
  if (head.paramOpen >= 0) {
    const before = code
      .slice(0, head.paramOpen)
      .replace(/\s+$/, '')
      .replace(/<[^<>]*>$/, '');
    const id = /([A-Za-z0-9_$]+)\s*$/.exec(before);
    // `function (…)` and `async (…)` are anonymous; anything else is the name
    // its author gave it.
    if (id && !['function', 'async', 'new', 'return', 'await'].includes(id[1]!)) return id[1]!;

    const assigned =
      /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\s*)?$/.exec(
        before,
      );
    if (assigned) return assigned[1]!;
  }

  // An anonymous function handed to a call: name it by that call's first
  // string argument, read from the RAW text at an index the blanked text
  // located. `server.registerTool('vault_request_fill', …, handler)` is the
  // shape, and this is how both fill paths get the names their authors use.
  const from = head.paramOpen >= 0 ? head.paramOpen : head.bodyOpen;
  let depth = 0;
  for (let i = from - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (c === ')') depth += 1;
    else if (c === '(') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const lit = /^\s*(['"])(.*?)\1/.exec(raw.slice(i + 1, i + 200));
      if (lit) return lit[2]!;
      const callee = /([A-Za-z0-9_$.]+)\s*$/.exec(code.slice(0, i));
      return callee ? `${callee[1]}(…)` : '(anonymous)';
    }
  }
  return '(anonymous)';
}

/**
 * The first string literal argument of the call whose `(` follows `at`.
 *
 * Located in the blanked text and read from the raw text, so a channel name in
 * a comment cannot be mistaken for a channel and a real one cannot be missed.
 */
export function firstStringArg(code: string, raw: string, at: number): string | null {
  const open = code.indexOf('(', at);
  if (open === -1) return null;
  const lit = /^\s*(['"])(.*?)\1/.exec(raw.slice(open + 1, open + 200));
  return lit ? lit[2]! : null;
}

/** `line:col`-free location, good enough to point a reader at the right place. */
export function lineOf(src: string, at: number): number {
  return src.slice(0, at).split('\n').length;
}

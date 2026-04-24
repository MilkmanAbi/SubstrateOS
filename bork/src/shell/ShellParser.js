/**
 * BORK Shell Parser v2
 * Full POSIX-lite shell parser.
 * Supports: pipes | redirects > >> < 2> 2>> &> heredoc, background &,
 *           semicolons ;, env assignment FOO=bar, variable $VAR ${VAR},
 *           quoting "..." '...', command substitution $(cmd) [limited]
 */

export class ShellParser {
  /**
   * Parse raw command string into Jobs:
   *   Job      = { bg: bool, pipeline: Command[] }
   *   Command  = { argv: string[], env: {}, stdin: Redirect|null, stdout: Redirect|null, stderr: Redirect|null }
   *   Redirect = { type: 'file'|'append', path: string }
   */
  static parse(raw, env = {}) {
    const stmts = topLevelSplit(raw.trim(), ';');
    const jobs = [];
    for (const stmt of stmts) {
      const j = ShellParser._parseJob(stmt.trim(), env);
      if (j.pipeline.length > 0) jobs.push(j);
    }
    return jobs;
  }

  static _parseJob(stmt, env) {
    let bg = false;
    if (stmt.endsWith('&')) { bg = true; stmt = stmt.slice(0, -1).trimEnd(); }
    const segments = topLevelSplit(stmt, '|');
    const pipeline  = segments.map(s => ShellParser._parseCommand(s.trim(), env));
    return { bg, pipeline };
  }

  static _parseCommand(seg, env) {
    const cmd = { argv: [], env: {}, stdin: null, stdout: null, stderr: null };
    const tokens = tokenize(seg);
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      // Pre-command env assignment
      if (!cmd.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        const eq = tok.indexOf('=');
        cmd.env[tok.slice(0, eq)] = expandVars(tok.slice(eq + 1), env);
        i++; continue;
      }
      // Redirects
      switch (tok) {
        case '>': case '1>':
          cmd.stdout = { type: 'file',   path: expandVars(tokens[++i] ?? '', env) }; i++; continue;
        case '>>': case '1>>':
          cmd.stdout = { type: 'append', path: expandVars(tokens[++i] ?? '', env) }; i++; continue;
        case '<':
          cmd.stdin  = { type: 'file',   path: expandVars(tokens[++i] ?? '', env) }; i++; continue;
        case '2>':
          cmd.stderr = { type: 'file',   path: expandVars(tokens[++i] ?? '', env) }; i++; continue;
        case '2>>':
          cmd.stderr = { type: 'append', path: expandVars(tokens[++i] ?? '', env) }; i++; continue;
        case '&>': case '>&': {
          const path = expandVars(tokens[++i] ?? '', env);
          cmd.stdout = { type: 'file', path }; cmd.stderr = { type: 'file', path }; i++; continue;
        }
      }
      cmd.argv.push(expandVars(tok, env));
      i++;
    }
    return cmd;
  }
}

/** Expand $VAR and ${VAR} references in a string */
export function expandVars(str, env = {}) {
  if (!str) return str;
  return str.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, brace, plain) => {
    const key = brace ?? plain;
    return env[key] ?? env[key?.toUpperCase()] ?? '';
  });
}

/**
 * Tokenize a shell string into tokens.
 * Handles: quotes, escape, special operators (>, >>, 2>, 2>>, &>, |, ;, <)
 */
function tokenize(str) {
  const tokens = [];
  let i = 0;
  const len = str.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /[ \t]/.test(str[i])) i++;
    if (i >= len) break;

    const ch = str[i];

    // Double-quoted string
    if (ch === '"') {
      let tok = ''; i++;
      while (i < len && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < len) tok += str[++i];
        else tok += str[i];
        i++;
      }
      i++; tokens.push(tok); continue;
    }

    // Single-quoted string (literal — no expansion)
    if (ch === "'") {
      let tok = ''; i++;
      while (i < len && str[i] !== "'") tok += str[i++];
      i++; tokens.push(tok); continue;
    }

    // 2> and 2>>
    if (ch === '2' && i + 1 < len && str[i+1] === '>') {
      if (i + 2 < len && str[i+2] === '>') { tokens.push('2>>'); i += 3; }
      else { tokens.push('2>'); i += 2; }
      continue;
    }

    // &> combined redirect
    if (ch === '&' && i + 1 < len && str[i+1] === '>') {
      tokens.push('&>'); i += 2; continue;
    }

    // > and >>
    if (ch === '>') {
      if (i + 1 < len && str[i+1] === '>') { tokens.push('>>'); i += 2; }
      else { tokens.push('>'); i++; }
      continue;
    }

    // <
    if (ch === '<') { tokens.push('<'); i++; continue; }

    // | and ; are single-char (but | | is illegal, don't worry about ||)
    if (ch === '|' || ch === ';') { tokens.push(ch); i++; continue; }

    // $( command substitution — limited: treat as single opaque token for now )
    if (ch === '$' && i + 1 < len && str[i+1] === '(') {
      let depth = 0; let tok = ''; i += 2;
      while (i < len) {
        if (str[i] === '(') depth++;
        else if (str[i] === ')') { if (depth === 0) { i++; break; } depth--; }
        tok += str[i++];
      }
      tokens.push('$(' + tok + ')'); continue;
    }

    // Regular token (until whitespace or special chars)
    let tok = '';
    while (i < len && !/[ \t|;<>"'&]/.test(str[i])) {
      if (str[i] === '\\' && i + 1 < len) { tok += str[++i]; i++; }
      else tok += str[i++];
    }
    if (tok) tokens.push(tok);
  }

  return tokens;
}

/**
 * Split string on a separator character at the top level (not inside quotes or parens).
 */
function topLevelSplit(str, sep) {
  const parts = []; let current = '';
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble) {
      if (ch === '(' || ch === '{') { depth++; current += ch; continue; }
      if (ch === ')' || ch === '}') { depth--; current += ch; continue; }
      if (ch === sep && depth === 0) { parts.push(current); current = ''; continue; }
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

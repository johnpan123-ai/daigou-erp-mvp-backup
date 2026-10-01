/**
 * Conservative PostgreSQL lexical canonicalization, algorithm 3.
 * No function-name exceptions, algebraic rewrites, or business path allowlists.
 * Comments cannot alter quote state; literals and quoted identifiers remain
 * case/whitespace sensitive. Unknown/malformed quoting fails closed.
 */
export const SQL_CANONICAL_ALGORITHM = 'POSTGRESQL_LEXICAL_V3';

const token = (kind, value) => ({ kind, value });
const atom = item => item && ['string', 'number'].includes(item.kind);
const types = new Set(['text', 'integer', 'bigint', 'boolean', 'jsonb', 'uuid', 'numeric']);
const expressionPredecessors = new Set(['select', 'return', 'default', 'where', '=', ':=', ',', '(']);

export function tokenizeSql(value, { formatTemplate = false } = {}) {
  const source = String(value ?? '');
  const output = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const character = source[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    const directive = formatTemplate && source.slice(index).match(/^%(?:%|(?:\d+\$)?-?(?:\d+|\*(?:\d+\$)?)?[sIL])/u)?.[0];
    if (directive) { output.push(token('format-directive', directive)); index += directive.length; continue; }
    const parameter = source.slice(index).match(/^\$\d+/u)?.[0];
    if (parameter) { output.push(token('parameter', parameter)); index += parameter.length; continue; }
    if (source.startsWith('--', index)) {
      while (index < source.length && !/[\r\n]/u.test(source[index])) index += 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < source.length && depth) {
        if (source.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (source.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth) throw new Error('SQL_CANONICAL_UNTERMINATED_COMMENT');
      continue;
    }
    const dollar = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u)?.[0];
    if (dollar) {
      const end = source.indexOf(dollar, index + dollar.length);
      if (end < 0) throw new Error('SQL_CANONICAL_UNTERMINATED_DOLLAR_QUOTE');
      output.push(token('string', source.slice(index + dollar.length, end)));
      index = end + dollar.length; continue;
    }
    // Escape/Unicode/bit/hex strings retain their entire lexeme: decoding them
    // without session settings could incorrectly prove equivalence.
    const prefix = source.slice(index).match(/^(?:[eEbBxX]|[uU]&)(?=['"])/u)?.[0] ?? '';
    const quote = prefix ? source[index + prefix.length] : character;
    if (quote === "'" || quote === '"') {
      index += prefix.length + 1;
      let content = ''; let closed = false;
      while (index < source.length) {
        if (prefix.toLowerCase() === 'e' && source[index] === '\\') {
          content += source.slice(index, index + 2); index += 2; continue;
        }
        if (source[index] === quote) {
          if (source[index + 1] === quote) { content += quote; index += 2; continue; }
          index += 1; closed = true; break;
        }
        content += source[index]; index += 1;
      }
      if (!closed) throw new Error('SQL_CANONICAL_UNTERMINATED_QUOTE');
      output.push(prefix ? token('opaque', source.slice(start, index))
        : token(quote === "'" ? 'string' : 'identifier', content));
      continue;
    }
    const word = source.slice(index).match(/^[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9$\u0080-\uFFFF]*/u)?.[0];
    if (word) { output.push(token('word', word.replace(/[A-Z]/gu, value => value.toLowerCase()))); index += word.length; continue; }
    const number = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u)?.[0];
    if (number) { output.push(token('number', number)); index += number.length; continue; }
    const operator = source.slice(index).match(/^(?:::|:=|=>|[+\-*/<>=~!@#%^&|`?]+)/u)?.[0];
    if (operator) { output.push(token('operator', operator)); index += operator.length; continue; }
    output.push(token('punctuation', character)); index += 1;
  }
  return output;
}

function normalizeExecuteOnlyTemplates(tokens, options) {
  const templateIndexes = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'format' || tokens[index + 1]?.value !== '('
      || tokens[index + 2]?.kind !== 'string') continue;
    if (tokens[index - 1]?.value === 'execute') { templateIndexes.add(index + 2); continue; }
    if (tokens[index - 1]?.value !== ':=' || tokens[index - 2]?.kind !== 'word') continue;
    const name = tokens[index - 2].value;
    // Closed def/use proof: the variable is only declared as text, assigned
    // literal format templates, and consumed directly by EXECUTE. Any return,
    // logging, concatenation, reassignment, argument or unknown use blocks this
    // normalization. No variable or function name is privileged.
    const uses = tokens.flatMap((item, i) => item.kind === 'word' && item.value === name ? [i] : []);
    const safe = uses.every(i => tokens[i - 1]?.value === 'execute'
      || (tokens[i + 1]?.value === 'text' && tokens[i + 2]?.value === ';')
      || (tokens[i + 1]?.value === ':=' && tokens[i + 2]?.value === 'format'
        && tokens[i + 3]?.value === '(' && tokens[i + 4]?.kind === 'string'));
    if (safe && uses.some(i => tokens[i - 1]?.value === 'execute')) templateIndexes.add(index + 2);
  }
  return tokens.map((item, index) => templateIndexes.has(index)
    ? token('execute-sql-template', normalizeTokens(tokenizeSql(item.value, { formatTemplate: true }), options)) : item);
}

function normalizeTokens(input, { resolvedFunctionAliases = {} } = {}) {
  let tokens = input;
  // Only a literal cast and parentheses around a literal expression. Never
  // rewrite identifiers, function calls, boolean predicates or precedence.
  for (let pass = 0; pass < 4; pass += 1) {
    const result = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const values = tokens.slice(index, index + 6).map(item => item.value);
      if (values[0] === 'cast' && values[1] === '(' && atom(tokens[index + 2])
        && values[3] === 'as' && tokens[index + 4]?.kind === 'word'
        && types.has(values[4]) && values[5] === ')') {
        result.push(tokens[index + 2], token('operator', '::'), tokens[index + 4]);
        index += 5; continue;
      }
      const previous = result.at(-1)?.value;
      if (values[0] === '(' && (!previous || expressionPredecessors.has(previous))
        && atom(tokens[index + 1])) {
        const castEnd = values[2] === '::' && types.has(values[3]) ? 4 : 2;
        if (values[castEnd] === ')') {
          result.push(...tokens.slice(index + 1, index + castEnd)); index += castEnd; continue;
        }
      }
      result.push(tokens[index]);
    }
    tokens = result;
  }
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    // Qualified functions may be rewritten only with catalog-proven resolution
    // supplied by the caller, never from a name-only exception.
    const [schema, dot, name, open] = tokens.slice(index, index + 4);
    const alias = schema?.kind === 'word' && name?.kind === 'word'
      && dot?.value === '.' && open?.value === '('
      ? resolvedFunctionAliases[`${schema.value}.${name.value}`] : null;
    if (alias) { result.push(token('word', alias)); index += 2; }
    else if (schema?.kind === 'word' && dot?.value === '(' && resolvedFunctionAliases[schema.value]) {
      result.push(token('word', resolvedFunctionAliases[schema.value]));
    }
    else result.push(tokens[index]);
  }
  return result;
}

export function canonicalSqlTokens(value, options = {}) {
  const tokens = tokenizeSql(value);
  const isFunction = tokens.some((item, index) => item.value === 'create'
    && tokens.slice(index + 1, index + 5).some(candidate => ['function', 'procedure'].includes(candidate.value)));
  const languageIndex = tokens.findIndex(item => item.kind === 'word' && item.value === 'language');
  const language = tokens[languageIndex + 1]?.value;
  if (isFunction && ['sql', 'plpgsql'].includes(language)) {
    // Only AS's outer body literal is code. Nested dollar strings inside that
    // body remain values, even when they contain SQL-looking text.
    const bodyIndex = tokens.findIndex((item, index) => item.kind === 'string'
      && tokens[index - 1]?.value === 'as');
    if (bodyIndex < 0) throw new Error('SQL_CANONICAL_FUNCTION_BODY_REQUIRED');
    tokens[bodyIndex] = token('body', normalizeTokens(
      normalizeExecuteOnlyTemplates(tokenizeSql(tokens[bodyIndex].value), options), options));
  }
  return normalizeTokens(tokens, options);
}

export const canonicalSql = (value, options) => JSON.stringify(canonicalSqlTokens(value, options));

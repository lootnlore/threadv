// Strips comments, indentation and blank lines from the browser modules,
// which hold the page's first frame (see layout.mjs): fewer bytes to wait
// for. It reads the code as JavaScript does (strings, template literals,
// regular expressions, comments), so nothing that only looks like a
// comment is touched, and keeps every line break that ends a line of code,
// so automatic semicolons fall where they did. Inside a template literal
// everything is kept as written.

const WORD = /[\w$]/;
// After these words an expression starts, so a slash begins a regular
// expression ("return /x/"); after any other word it divides ("a / b").
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);

/** `src` without comments, indentation or blank lines. */
export function stripJs(src) {
  let out = '';
  let i = 0;
  let lastToken = ''; // the last thing that wasn't space or a comment: decides what a slash is
  const templates = []; // brace depths at which an open ${...} returns to its template
  let depth = 0;
  const emit = (text) => {
    out += text;
    lastToken = text;
  };
  const lineStart = () => out === '' || out.endsWith('\n');
  const newline = () => {
    if (!lineStart()) out += '\n'; // a blank line is dropped; a line of code keeps its end
  };
  // Whether a slash here begins a regular expression (or divides).
  const regexAllowed = () => {
    if (lastToken === '' || lastToken.endsWith('${')) return true; // an expression starts
    if (WORD.test(lastToken[0])) return BEFORE_EXPRESSION.has(lastToken); // a name or number divides; "return" and the like start an expression
    if (lastToken.length > 1) return false; // a string, template or regular expression just ended
    return lastToken !== ')' && lastToken !== ']';
  };
  // A template literal's text from i (just past ` or }), up to its end or a ${.
  const templateText = () => {
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '`') {
        i++;
        return { text: src.slice(start, i), open: false };
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        return { text: src.slice(start, i), open: true };
      } else i++;
    }
    throw new Error('stripJs: unterminated template literal');
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') {
      newline();
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      // Space between tokens: one, and only where it keeps two apart.
      while (src[i] === ' ' || src[i] === '\t' || src[i] === '\r') i++;
      if (!lineStart() && src[i] !== '\n' && i < src.length) out += ' ';
    } else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      if (out.endsWith(' ')) out = out.slice(0, -1);
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('stripJs: unterminated comment');
      const hadNewline = src.slice(i, end).includes('\n');
      i = end + 2;
      if (out.endsWith(' ')) out = out.slice(0, -1);
      if (hadNewline) newline();
      else if (WORD.test(out.at(-1) ?? '') && WORD.test(src[i] ?? '')) out += ' '; // "a/**/b" stays two words
    } else if (c === "'" || c === '"') {
      const start = i++;
      while (src[i] !== c) {
        if (src[i] === '\\') i++;
        if (i >= src.length || src[i] === '\n') throw new Error('stripJs: unterminated string');
        i++;
      }
      i++;
      emit(src.slice(start, i));
    } else if (c === '`') {
      i++;
      const { text, open } = templateText();
      emit(`\`${text}`);
      if (open) templates.push(depth++);
    } else if (c === '/' && regexAllowed()) {
      const start = i++;
      let inClass = false;
      while (inClass || src[i] !== '/') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        if (i >= src.length || src[i] === '\n') throw new Error('stripJs: unterminated regular expression');
        i++;
      }
      i++;
      while (WORD.test(src[i] ?? '')) i++; // flags
      emit(src.slice(start, i));
    } else if (c === '}' && templates.length && templates.at(-1) === depth - 1) {
      // The end of a ${...}: back into its template's text.
      templates.pop();
      depth--;
      i++;
      const { text, open } = templateText();
      emit(`}${text}`);
      if (open) templates.push(depth++);
    } else if (WORD.test(c)) {
      const start = i;
      while (i < src.length && WORD.test(src[i])) i++;
      // A number's own dots and exponent (1.5, 1e-3) belong to it.
      if (/\d/.test(c)) while (/[\w.]/.test(src[i] ?? '') || (/[+-]/.test(src[i]) && /e$/i.test(src.slice(start, i)))) i++;
      emit(src.slice(start, i));
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      emit(c);
      i++;
    }
  }
  return out.endsWith('\n') || out === '' ? out : `${out}\n`;
}

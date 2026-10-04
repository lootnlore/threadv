// The build's comment stripper (scripts/strip-js.mjs): it must never touch
// what only looks like a comment, join two tokens into one, or move a line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripJs } from '../scripts/strip-js.mjs';

test('strips comments and indentation, keeping every line', () => {
  assert.equal(stripJs('  /**\n   * doc\n   */\n  function f() {\n\n    return 1; // one\n  }\n'), '\n\n\nfunction f() {\n\nreturn 1;\n}\n');
  assert.equal(stripJs('a\n/* gone */\nb\n'), 'a\n\nb\n', 'line breaks stay: semicolons fall where they did, and line numbers are the source\'s');
  assert.equal(stripJs('f(a/**/b)\n'), 'f(a b)\n', 'a comment between words leaves them apart');
  assert.equal(stripJs('let a = -/**/-b;\n'), 'let a = - -b;\n', 'and between operators: never "--"');
});

test('keeps what only looks like a comment', () => {
  const kept = [
    "const a = 'http://x' + \"/* no */\";\n", // strings
    'const r = /\\/\\/[/*]x/g.test(s);\n', // regular expressions, with slashes escaped and in a class
    'const t = `a // b ${x + `n${y}`} /* t */ c`;\n', // template literals, nested
    'x = `\n  keep\n    this\n`;\n', // a template's lines, as written
    'return /re/.test(s)\n', // a regular expression after return
    'if (ok) /a  b/.test(s);\n', // and after a condition's parenthesis
    'x = (a) / b / c;\n', // division, after a value's parenthesis too
    'n = i++ / 2; m = j-- / 2;\n', // and after ++ and --
    'x = a+++/re  x/.source.length;\n', // but a regular expression after "a++ +"
    'n = 1.5e-3 / 2;\n', // numbers
    "s.replace(/[&<>\"']/g, f);\n",
  ];
  for (const code of kept) assert.equal(stripJs(code), code, code);
  assert.equal(stripJs('const t = `${x /* gone */}`;\n'), 'const t = `${x }`;\n', 'a comment inside ${...} is code');
});

test('is idempotent, and refuses what it cannot read', () => {
  const once = stripJs('a(); // x\n/* y */ b();\n');
  assert.equal(stripJs(once), once);
  for (const bad of ["'open", '/* open', '`open', '/open\n']) assert.throws(() => stripJs(bad), /stripJs/);
});

/**
 * One-shot native compatibility fix for react-native-track-player 4.1.2 on
 * RN 0.85.
 *
 * Converts every expression-bodied @ReactMethod
 *     fun X(...) = scope.launch { ... }
 * into a void-returning block-bodied function
 *     fun X(...) {
 *         scope.launch { ... }
 *     }
 * TurboModule interop on RN 0.85 rejects @ReactMethods whose JVM return type
 * is not void; `scope.launch {}` returns a Job. The Job was never consumed,
 * so this is a pure signature change — behaviour is identical.
 *
 * Depth bookkeeping: after conversion the function brace sits at depth 1
 * above the launch lambda (depth 2). When the lambda's `}` brings depth back
 * to 1, we emit one extra `}` to close the function. Methods that are already
 * block-bodied (setupPlayer, isServiceRunning) close at depth 0 as usual.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname, '..', 'node_modules', 'react-native-track-player',
  'android', 'src', 'main', 'java', 'com', 'doublesymmetry', 'trackplayer',
  'module', 'MusicModule.kt'
);

const srcRaw = fs.readFileSync(file, 'utf8');
const hadCrlf = srcRaw.includes('\r\n');
const src = srcRaw.replace(/\r\n/g, '\n');
const lines = src.split('\n');

/** Strip string literals and comments so brace counting sees code only. */
function codeOnly(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?(?:\*\/|$)/g, '');
}

function braceBalance(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    const c = codeOnly(line);
    n += (c.match(/\{/g) || []).length - (c.match(/\}/g) || []).length;
  }
  return n;
}

const out = [];
let converted = 0;
let inHeader = false;   // @ReactMethod seen; scanning for its `fun` line
let bodyDepth = 0;      // absolute brace depth since the function opened
let closeAt = 0;        // depth at which the function body ends (1 = converted, 0 = native block)

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const code = codeOnly(raw);
  const opens = (code.match(/\{/g) || []).length;
  const closes = (code.match(/\}/g) || []).length;

  // ---- inside a method body ----
  if (bodyDepth > 0) {
    bodyDepth += opens - closes;
    out.push(raw);
    if (bodyDepth === closeAt) {
      if (closeAt === 1) {
        // Launch lambda closed; emit the function's own closing brace.
        out.push('    }');
      }
      bodyDepth = 0;
      closeAt = 0;
    }
    continue;
  }

  // ---- scanning for the fun line after @ReactMethod ----
  if (inHeader) {
    if (/^\s*fun\s/.test(code)) {
      const exprSame = /^(\s*fun\s+\w+\s*\([^)]*\))\s*=\s*(scope\.launch\s*\{)$/.exec(code);
      const mangled = /^(\s*fun\s+\w+\s*\([^)]*\))\s*(scope\.launch\s*\{)$/.exec(code);
      const exprNext = /^(\s*fun\s+\w+\s*\([^)]*\))\s*=\s*$/.test(code);
      const blockBody = /^\s*fun\s+\w+\s*\([^)]*\)\s*\{/.test(code);

      if (exprSame) {
        out.push(`${exprSame[1]} {`);
        out.push(`        ${exprSame[2]}`);
        bodyDepth = 2;
        closeAt = 1;
        converted++;
        inHeader = false;
        continue;
      }
      if (mangled) {
        // Recover the pre-mangled form: `fun X(...) scope.launch {`
        out.push(`${mangled[1]} {`);
        out.push(`        ${mangled[2]}`);
        bodyDepth = 2;
        closeAt = 1;
        converted++;
        inHeader = false;
        continue;
      }
      if (exprNext) {
        // `fun X(...) =` with scope.launch on the next line.
        out.push(code.replace(/\s*=\s*$/, ' {'));
        inHeader = false;
        // Stay waiting for the `scope.launch {` line: handle below via exprNextWait.
        bodyDepth = 1;
        closeAt = 1;
        continue;
      }
      if (blockBody) {
        out.push(raw);
        bodyDepth = opens - closes;
        closeAt = 0;
        inHeader = false;
        continue;
      }
      // fun without a recognizable body start — emit and stop tracking.
      out.push(raw);
      inHeader = false;
      continue;
    }
    // exprNext wait state: bodyDepth==1 awaiting `scope.launch {`
    if (bodyDepth === 1 && closeAt === 1 && /^\s*scope\.launch\s*\{$/.test(code.trim())) {
      out.push(raw);
      bodyDepth = 2;
      converted++;
      continue;
    }
    if (/@ReactMethod/.test(code)) {
      out.push(raw); // consecutive annotation lines
      continue;
    }
    out.push(raw);
    if (code.trim() !== '') inHeader = false;
    continue;
  }

  // ---- normal line ----
  if (/@ReactMethod/.test(code)) {
    inHeader = true;
  }
  out.push(raw);
}

fs.writeFileSync(file, out.join('\n').replace(/\n/g, hadCrlf ? '\r\n' : '\n'), 'utf8');
console.log(`Converted ${converted} expression-bodied @ReactMethod functions`);

// ---- self-verification (comment/string aware) ----
const result = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const exprLeft = (result.match(/@ReactMethod[\s\S]{0,160}?fun\s+\w+\s*\([^)]*\)\s*=\s*(scope\.launch)?\s*\n/g) || []).length;
const mangledLeft = (result.match(/\) scope\.launch/g) || []).length;
const balance = braceBalance(result);
const methodCount = (result.match(/@ReactMethod/g) || []).length;

console.log(`expression-bodied left: ${exprLeft}`);
console.log(`mangled ") scope.launch" left: ${mangledLeft}`);
console.log(`brace balance: ${balance} ${balance === 0 ? 'OK' : 'MISMATCH'}`);
console.log(`@ReactMethod count: ${methodCount}`);
console.log(`getName intact: ${result.includes('return "TrackPlayerModule"')}`);

if (exprLeft > 0 || mangledLeft > 0 || balance !== 0 || methodCount < 39) {
  console.error('VERIFICATION FAILED');
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED');
}

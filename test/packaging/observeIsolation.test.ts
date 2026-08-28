import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The observability module must stay out of the main entry point's graph.
 *
 * Shipping it inside the SDK rather than as a separate package was a deliberate
 * call for developer experience, but it gave up the one thing a package
 * boundary was doing for free: guaranteeing that a local, offline deployment
 * never carries Govplane Cloud code. This test is what replaces it.
 *
 * Three kinds of reference, and only one of them is a problem:
 *
 *   import { x } from '../observe/y.js'   forbidden — pulls the module into the
 *                                         graph for every consumer
 *   import type { X } from '../observe/y' allowed — erased at compile time
 *   await import('../observe/y.js')       allowed — resolved only if the branch
 *                                         runs, and split into its own chunk
 *
 * `createRemoteClient` deliberately uses the last two.
 */

const SRC = join(process.cwd(), 'src');
const OBSERVE = join('src', 'observe');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  const full = join(dir, entry);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const sourceFiles = (predicate: (path: string) => boolean): string[] => walk(SRC)
  .filter((f) => f.endsWith('.ts'))
  .filter(predicate);

/** Static value imports only: `import type` and `await import()` are excluded. */
const staticValueImportsOf = (contents: string, moduleMatch: RegExp): string[] => contents
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^(import|export)\b/.test(line))
  .filter((line) => !/^import\s+type\b/.test(line))
  .filter((line) => !/^export\s+type\b/.test(line))
  .filter((line) => moduleMatch.test(line));

describe('observe stays out of the main entry point', () => {
  it('is never statically imported from outside src/observe', () => {
    const offenders = sourceFiles((f) => !f.includes(OBSERVE))
      .flatMap((f) => staticValueImportsOf(readFileSync(f, 'utf8'), /observe\//)
        .map((line) => `${f}: ${line}`));

    expect(offenders).toEqual([]);
  });

  it('is reachable from the client only by dynamic import', () => {
    // The mechanism that keeps the previous assertion true while still letting
    // a configured client use the module. If this disappears, observability
    // has either been unwired or made unconditional.
    const remote = readFileSync(join(SRC, 'client', 'createRemoteClient.ts'), 'utf8');
    expect(remote).toMatch(/await import\(\s*'\.\.\/observe\//);
  });

  it('only reaches back into the SDK for types, never for behaviour', () => {
    // A value import outward would put engine code in observe's own graph and
    // invite a cycle later. Types vanish at compile time.
    const offenders = sourceFiles((f) => f.includes(OBSERVE))
      .flatMap((f) => staticValueImportsOf(readFileSync(f, 'utf8'), /from\s+['"]\.\.\//)
        .map((line) => `${f}: ${line}`));

    expect(offenders).toEqual([]);
  });
});

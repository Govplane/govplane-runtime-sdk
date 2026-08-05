import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';

/**
 * The package ships a single ESM build that CommonJS consumers load through
 * `require()`. Node can only do that synchronously, so the entry graph must stay
 * synchronous: a top-level `await` anywhere in it turns the module async and
 * every `require('@govplane/runtime-sdk')` fails with `ERR_REQUIRE_ASYNC_MODULE`.
 *
 * Nothing in the type system prevents it, and the ESM test suite would keep
 * passing, so the breakage would surface only in a CommonJS consumer's
 * application. This test is the guard.
 */

const SOURCE_ROOT = join(process.cwd(), 'src');

const sourceFiles = (directory: string): string[] => readdirSync(directory)
  .flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });

/** True for nodes that open a new `await` scope, which we must not descend into. */
const isFunctionLike = (node: ts.Node): boolean => ts.isFunctionDeclaration(node)
  || ts.isFunctionExpression(node)
  || ts.isArrowFunction(node)
  || ts.isMethodDeclaration(node)
  || ts.isConstructorDeclaration(node)
  || ts.isGetAccessorDeclaration(node)
  || ts.isSetAccessorDeclaration(node);

/** Locations of any `await` that would execute at module evaluation time. */
const topLevelAwaits = (file: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );

  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    // Inside a function the `await` belongs to that function, not the module.
    if (isFunctionLike(node)) {
      return;
    }

    const isAwait = ts.isAwaitExpression(node)
      || (ts.isForOfStatement(node) && node.awaitModifier !== undefined);

    if (isAwait) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file.replace(process.cwd(), '.')}:${line + 1}`);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
};

describe('the entry graph stays require()-able from CommonJS', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('finds source files to check', () => {
    // Guards the guard: a broken glob would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no top-level await', () => {
    const offenders = files.flatMap(topLevelAwaits);

    expect(offenders).toEqual([]);
  });
});

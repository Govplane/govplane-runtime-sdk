import type { WhenAstV1 } from "./types.js";

// Normalizes a path by stripping the optional "ctx." prefix, then resolves
// it against the context object. Both "plan" and "ctx.plan" are equivalent.
function getPath(ctx: Record<string, unknown>, path: string): any {
  const normalizedPath = path.startsWith("ctx.") ? path.slice(4) : path;
  const parts = normalizedPath.split(".");
  let cur: any = ctx;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

export function evalWhen(node: WhenAstV1, ctx: Record<string, unknown>): boolean {
  switch (node.op) {
    case "and": {
      // Support both canonical `conditions` and legacy `args`
      const children = (node as any).conditions ?? (node as any).args ?? [];
      return (children as WhenAstV1[]).every(n => evalWhen(n, ctx));
    }
    case "or": {
      const children = (node as any).conditions ?? (node as any).args ?? [];
      return (children as WhenAstV1[]).some(n => evalWhen(n, ctx));
    }
    case "not": {
      // Support both canonical `condition` and legacy `arg`
      const child = (node as any).condition ?? (node as any).arg;
      return !evalWhen(child as WhenAstV1, ctx);
    }

    case "exists": {
      const v = getPath(ctx, node.path);
      return v !== undefined && v !== null;
    }

    case "in": {
      const v = getPath(ctx, node.path);
      return node.values.some(x => x === v);
    }

    case "eq": return getPath(ctx, node.path) === node.value;
    // `neq` is the canonical spelling; `ne` is kept for legacy bundles
    case "neq":
    case "ne": return getPath(ctx, node.path) !== node.value;

    case "gt": return Number(getPath(ctx, node.path)) > Number(node.value);
    case "gte": return Number(getPath(ctx, node.path)) >= Number(node.value);
    case "lt": return Number(getPath(ctx, node.path)) < Number(node.value);
    case "lte": return Number(getPath(ctx, node.path)) <= Number(node.value);

    default:
      return false;
  }
}
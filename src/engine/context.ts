/**
 * Limits applied to evaluation context.
 *
 * Only `allowedKeys` is required. `validateContext` below already falls back to
 * the defaults for every other field — the type simply demanded more than the
 * code ever did, forcing callers to restate three numbers to express "these are
 * my keys".
 */
export interface ContextPolicy {
  allowedKeys: string[];
  maxStringLen?: number;
  maxArrayLen?: number;
  blockLikelyPiiKeys?: boolean;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  allowedKeys: [
    "plan",
    "country",
    "requestTier",
    "feature",
    "amount",
    "isAuthenticated",
    "role",
  ],
  maxStringLen: 64,
  maxArrayLen: 10,
  blockLikelyPiiKeys: true,
};

// Heurística simple (no perfecta): bloquea nombres de claves típicas de PII
const PII_KEY_PATTERNS: RegExp[] = [
  /email/i,
  /phone/i,
  /mobile/i,
  /name/i,
  /firstname/i,
  /lastname/i,
  /address/i,
  /street/i,
  /postcode|postal/i,
  /city/i,
  /ip/i,
  /ssn/i,
  /dni|nie/i,
  /passport/i,
];

const DEFAULT_POLICY: Required<Omit<ContextPolicy, "allowedKeys">> = {
  maxStringLen: 80,
  maxArrayLen: 25,
  blockLikelyPiiKeys: true,
};

export function validateContext(
  ctx: Record<string, unknown>,
  policy: ContextPolicy,
): void {
  // Normalize allowedKeys: strip optional "ctx." prefix so both "plan" and
  // "ctx.plan" are accepted interchangeably in the policy configuration.
  const allowed = new Set(policy.allowedKeys.map(k => k.startsWith("ctx.") ? k.slice(4) : k));
  const maxStringLen = policy.maxStringLen ?? DEFAULT_POLICY.maxStringLen;
  const maxArrayLen = policy.maxArrayLen ?? DEFAULT_POLICY.maxArrayLen;
  const blockLikelyPiiKeys = policy.blockLikelyPiiKeys ?? DEFAULT_POLICY.blockLikelyPiiKeys;

  for (const [k, v] of Object.entries(ctx)) {
    if (!allowed.has(k)) {
      throw new Error(`Context key not allowed: ${k}`);
    }

    if (blockLikelyPiiKeys) {
      for (const re of PII_KEY_PATTERNS) {
        if (re.test(k)) {
          throw new Error(`Context key looks like PII and is blocked: ${k}`);
        }
      }
    }

    if (v === null || v === undefined) continue;

    const t = typeof v;
    if (t === "boolean" || t === "number") continue;

    if (t === "string") {
      if ((v as string).length > maxStringLen) throw new Error(`Context value too long: ${k}`);
      continue;
    }

    if (Array.isArray(v)) {
      if (v.length > maxArrayLen) throw new Error(`Context array too long: ${k}`);
      for (const it of v) {
        if (typeof it !== "string") throw new Error(`Invalid array value type: ${k}`);
        if (it.length > maxStringLen) throw new Error(`Invalid array value length: ${k}`);
      }
      continue;
    }

    throw new Error(`Invalid context type for ${k}`);
  }
}
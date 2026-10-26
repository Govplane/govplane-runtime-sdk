import { ENVIRONMENTS, isNonEmptyString, isRecord } from './types.js';

/**
 * Structural validation of a runtime bundle.
 *
 * The checks and their codes mirror `@govplane/cli`'s validator and the remote
 * validator in `gp-worker`, so a bundle that `govplane validate` accepts is one
 * this SDK will load, and an operator reading a code in an application log
 * finds the same code in the CLI's documentation.
 *
 * This is not a linter. It reports what would make evaluation unsafe or
 * meaningless, and says nothing about style — the CLI does that.
 */

export interface ValidationIssue {
  code: string;
  /** JSON path into the document, e.g. `$.policies[2].rules[0].target`. */
  path: string;
  message: string;
}

export interface ValidateOptions {
  /**
   * Whether `orgId` and `projectId` are required.
   *
   * `required` for bundles fetched from Govplane Cloud — the control plane
   * always materialises them with a scope, and their absence means something
   * went wrong in transit. `optional` for local bundles, which are built
   * without one.
   */
  scope?: 'required' | 'optional';
}

const EFFECT_TYPES = ['allow', 'deny', 'kill_switch', 'requires_approval', 'throttle', 'custom'];

const CONDITION_OPERATORS = [
  'eq', 'neq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'in', 'exists',
];

const COMPARISON_OPERATORS = ['eq', 'neq', 'ne', 'gt', 'gte', 'lt', 'lte'];

const isScalar = (value: unknown): boolean => (
  value === null
  || typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'boolean'
);

const validateCondition = (
  condition: unknown,
  path: string,
  issues: ValidationIssue[],
  depth = 0,
): void => {
  // A condition tree deep enough to hit this is malformed or hostile; either
  // way, refusing is better than recursing.
  if (depth > 32) {
    issues.push({ code: 'INVALID_CONDITION_AST', path, message: 'Condition nesting is too deep.' });
    return;
  }

  if (!isRecord(condition)) {
    issues.push({ code: 'INVALID_CONDITION_AST', path, message: 'Condition must be an object.' });
    return;
  }

  const { op } = condition;
  if (typeof op !== 'string' || !CONDITION_OPERATORS.includes(op)) {
    issues.push({
      code: 'UNSUPPORTED_CONDITION_OPERATOR',
      path: `${path}.op`,
      message: `Unsupported condition operator: ${String(op)}`,
    });
    return;
  }

  if (op === 'and' || op === 'or') {
    // `conditions` is canonical; `args` is accepted for bundles written against
    // the earlier shape, matching what the engine evaluates.
    const branches = Array.isArray(condition.conditions)
      ? condition.conditions
      : condition.args;
    if (!Array.isArray(branches) || branches.length === 0) {
      issues.push({
        code: 'INVALID_CONDITION_AST',
        path,
        message: `"${op}" requires a non-empty conditions array.`,
      });
      return;
    }
    branches.forEach((branch, index) => {
      validateCondition(branch, `${path}.conditions[${index}]`, issues, depth + 1);
    });
    return;
  }

  if (op === 'not') {
    const inner = condition.condition ?? condition.arg;
    if (inner === undefined) {
      issues.push({ code: 'INVALID_CONDITION_AST', path, message: '"not" requires a condition.' });
      return;
    }
    validateCondition(inner, `${path}.condition`, issues, depth + 1);
    return;
  }

  if (!isNonEmptyString(condition.path)) {
    issues.push({
      code: 'INVALID_CONDITION_AST',
      path: `${path}.path`,
      message: `"${op}" requires a non-empty path.`,
    });
  }

  if (op === 'in') {
    if (!Array.isArray(condition.values) || condition.values.length === 0) {
      issues.push({
        code: 'INVALID_CONDITION_AST',
        path: `${path}.values`,
        message: '"in" requires a non-empty values array.',
      });
    }
    return;
  }

  if (COMPARISON_OPERATORS.includes(op) && !isScalar(condition.value)) {
    issues.push({
      code: 'INVALID_CONDITION_AST',
      path: `${path}.value`,
      message: `"${op}" requires a scalar value.`,
    });
  }
};

const validateEffect = (effect: unknown, path: string, issues: ValidationIssue[]): void => {
  if (!isRecord(effect)) {
    issues.push({
      code: 'INVALID_RULE_EFFECT',
      path,
      message: 'effect must be an object with a type.',
    });
    return;
  }

  const {type} = effect;
  if (typeof type !== 'string' || !EFFECT_TYPES.includes(type)) {
    issues.push({
      code: 'INVALID_RULE_EFFECT',
      path: `${path}.type`,
      message: `effect.type must be one of: ${EFFECT_TYPES.join(', ')}`,
    });
    return;
  }

  if (type === 'custom' && !isNonEmptyString(effect.value)) {
    issues.push({
      code: 'INVALID_RULE_EFFECT',
      path: `${path}.value`,
      message: 'A custom effect requires a non-empty value.',
    });
  }

  // The descriptor is optional, but when present it has to be something the
  // host can read fields from. Its fields are not validated here: the runtime
  // passes them through untouched, so their meaning belongs to the host.
  if (type === 'requires_approval' && effect.approval !== undefined && !isRecord(effect.approval)) {
    issues.push({
      code: 'INVALID_RULE_EFFECT',
      path: `${path}.approval`,
      message: 'approval, when present, must be an object.',
    });
  }
};

const validateDefaults = (defaults: unknown, path: string, issues: ValidationIssue[]): void => {
  if (defaults === undefined) {
    return;
  }
  if (!isRecord(defaults)) {
    issues.push({ code: 'INVALID_DEFAULT_EFFECT', path, message: 'defaults must be an object.' });
    return;
  }

  const {effect} = defaults;
  if (typeof effect !== 'string' || !EFFECT_TYPES.includes(effect)) {
    issues.push({
      code: 'INVALID_DEFAULT_EFFECT',
      path: `${path}.effect`,
      message: `defaults.effect must be one of: ${EFFECT_TYPES.join(', ')}`,
    });
    return;
  }

  if (effect === 'kill_switch') {
    const {killSwitch} = defaults;
    if (!isRecord(killSwitch) || !isNonEmptyString(killSwitch.service)) {
      issues.push({
        code: 'MISSING_KILL_SWITCH_SERVICE',
        path: `${path}.killSwitch.service`,
        message: 'A kill_switch default requires killSwitch.service.',
      });
    }
  }

  if (
    effect === 'requires_approval'
    && defaults.approval !== undefined
    && !isRecord(defaults.approval)
  ) {
    issues.push({
      code: 'INVALID_APPROVAL_DEFAULT',
      path: `${path}.approval`,
      message: 'A requires_approval default may carry approval, and it must be an object.',
    });
  }

  if (effect === 'throttle') {
    const {throttle} = defaults;
    if (
      !isRecord(throttle)
      || typeof throttle.limit !== 'number'
      || typeof throttle.windowSeconds !== 'number'
      || !isNonEmptyString(throttle.key)
    ) {
      issues.push({
        code: 'INVALID_THROTTLE_DEFAULT',
        path: `${path}.throttle`,
        message: 'A throttle default requires numeric limit and windowSeconds, and a key.',
      });
    }
  }

  if (effect === 'custom' && !isNonEmptyString(defaults.customEffect)) {
    issues.push({
      code: 'INVALID_CUSTOM_DEFAULT',
      path: `${path}.customEffect`,
      message: 'A custom default requires a non-empty customEffect.',
    });
  }
};

const validateRule = (
  rule: unknown,
  path: string,
  issues: ValidationIssue[],
  seenIds: Set<string>,
): void => {
  if (!isRecord(rule)) {
    issues.push({ code: 'INVALID_RULE', path, message: 'Rule must be an object.' });
    return;
  }

  if (!isNonEmptyString(rule.id)) {
    issues.push({ code: 'MISSING_RULE_ID', path: `${path}.id`, message: 'id is required.' });
  } else if (seenIds.has(rule.id)) {
    issues.push({
      code: 'DUPLICATE_RULE_ID',
      path: `${path}.id`,
      message: `Duplicate rule id: "${rule.id}"`,
    });
  } else {
    seenIds.add(rule.id);
  }

  if (typeof rule.priority !== 'number' || Number.isNaN(rule.priority)) {
    issues.push({
      code: 'INVALID_RULE_PRIORITY',
      path: `${path}.priority`,
      message: 'priority must be a number.',
    });
  }

  const {target} = rule;
  if (!isRecord(target)) {
    issues.push({ code: 'INVALID_RULE_TARGET', path: `${path}.target`, message: 'target is required.' });
  } else {
    (['service', 'resource', 'action'] as const).forEach((field) => {
      if (!isNonEmptyString(target[field])) {
        issues.push({
          code: 'INVALID_RULE_TARGET',
          path: `${path}.target.${field}`,
          message: `target.${field} is required.`,
        });
      }
    });
  }

  validateEffect(rule.effect, `${path}.effect`, issues);

  if (rule.when !== undefined) {
    validateCondition(rule.when, `${path}.when`, issues);
  }
  if (rule.thenEffect !== undefined) {
    validateEffect(rule.thenEffect, `${path}.thenEffect`, issues);
  }
  if (rule.elseEffect !== undefined) {
    validateEffect(rule.elseEffect, `${path}.elseEffect`, issues);
  }
};

const validatePolicy = (
  policy: unknown,
  path: string,
  issues: ValidationIssue[],
  seenKeys: Set<string>,
): void => {
  if (!isRecord(policy)) {
    issues.push({ code: 'INVALID_POLICY', path, message: 'Policy must be an object.' });
    return;
  }

  const {policyKey} = policy;
  if (!isNonEmptyString(policyKey)) {
    issues.push({
      code: 'MISSING_POLICY_KEY',
      path: `${path}.policyKey`,
      message: 'policyKey is required.',
    });
  } else if (seenKeys.has(policyKey)) {
    issues.push({
      code: 'DUPLICATE_POLICY_KEY',
      path: `${path}.policyKey`,
      message: `Duplicate policy key: "${policyKey}"`,
    });
  } else {
    seenKeys.add(policyKey);
  }

  if (typeof policy.activeVersion !== 'number') {
    issues.push({
      code: 'INVALID_ACTIVE_VERSION',
      path: `${path}.activeVersion`,
      message: 'activeVersion must be a number.',
    });
  }

  validateDefaults(policy.defaults, `${path}.defaults`, issues);

  if (!Array.isArray(policy.rules)) {
    issues.push({ code: 'RULES_NOT_ARRAY', path: `${path}.rules`, message: 'rules must be an array.' });
    return;
  }

  const seenRuleIds = new Set<string>();
  policy.rules.forEach((rule, index) => {
    validateRule(rule, `${path}.rules[${index}]`, issues, seenRuleIds);
  });
};

/**
 * Validates a bundle's structure.
 *
 * Returns every problem rather than stopping at the first, so a malformed
 * bundle can be fixed in one pass instead of one error at a time.
 */
export const validateBundle = (
  document: unknown,
  options: ValidateOptions = {},
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  if (!isRecord(document)) {
    return [{ code: 'DOCUMENT_NOT_OBJECT', path: '$', message: 'Bundle must be a JSON object.' }];
  }

  if (document.schemaVersion !== 1) {
    issues.push({
      code: 'INVALID_SCHEMA_VERSION',
      path: '$.schemaVersion',
      message: `schemaVersion must be 1, got: ${String(document.schemaVersion)}`,
    });
  }

  if (options.scope !== 'optional') {
    (['orgId', 'projectId'] as const).forEach((field) => {
      if (!isNonEmptyString(document[field])) {
        issues.push({
          code: 'MISSING_SCOPE_FIELDS',
          path: `$.${field}`,
          message: `${field} is required for a bundle fetched from Govplane Cloud.`,
        });
      }
    });
  }

  if (!isNonEmptyString(document.env)) {
    issues.push({ code: 'INVALID_ENV', path: '$.env', message: 'env is required.' });
  } else if (!(ENVIRONMENTS as readonly string[]).includes(document.env)) {
    issues.push({
      code: 'INVALID_ENV',
      path: '$.env',
      message: `env must be one of: ${ENVIRONMENTS.join(', ')}`,
    });
  }

  // A revision counter, not a schema version: it climbs every time the control
  // plane materialises the bundle again.
  const { bundleVersion } = document;
  if (
    bundleVersion !== undefined
    && (!Number.isInteger(bundleVersion) || (bundleVersion as number) < 1)
  ) {
    issues.push({
      code: 'INVALID_BUNDLE_VERSION',
      path: '$.bundleVersion',
      message: 'bundleVersion must be a whole number of 1 or more.',
    });
  }

  if (!Array.isArray(document.policies)) {
    issues.push({
      code: 'POLICIES_NOT_ARRAY',
      path: '$.policies',
      message: 'policies must be an array.',
    });
    return issues;
  }

  const seenKeys = new Set<string>();
  document.policies.forEach((policy, index) => {
    validatePolicy(policy, `$.policies[${index}]`, issues, seenKeys);
  });

  return issues;
};

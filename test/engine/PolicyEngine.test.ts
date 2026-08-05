import { createPolicyEngine } from "../../src/engine/createPolicyEngine.js";
import type { RuntimeBundleV1 } from "../../src/engine/types.js";

function makeBundle(policies: any[]): RuntimeBundleV1 {
  return {
    schemaVersion: 1,
    orgId: "org_dev",
    projectId: "prj_web",
    env: "prod",
    generatedAt: "2026-01-01T00:00:00.000Z",
    policies,
  };
}

const baseContext = {
  plan: "free",
  country: "ES",
  amount: 100,
  isAuthenticated: true,
  role: "user",
  requestTier: "normal",
  feature: "checkout",
};

test("deny by default when no rule matches", () => {
  const bundle = makeBundle([
    { policyKey: "p1", activeVersion: 1, rules: [] },
  ]);

  const engine = createPolicyEngine({ getBundle: () => bundle });

  const out = engine.evaluate({
    target: { service: "payments", resource: "checkout", action: "create" },
    context: baseContext,
  });

  expect(out.decision).toBe("deny");
  expect(out.reason).toBe("default");
});

test("kill_switch overrides deny and allow", () => {
  const bundle = makeBundle([
    {
      policyKey: "allow-policy",
      activeVersion: 1,
      rules: [
        {
          id: "a1",
          status: "active",
          priority: 100,
          target: { service: "payments", resource: "checkout", action: "create" },
          effect: { type: "allow" },
        },
      ],
    },
    {
      policyKey: "deny-policy",
      activeVersion: 1,
      rules: [
        {
          id: "d1",
          status: "active",
          priority: 200,
          target: { service: "payments", resource: "checkout", action: "create" },
          effect: { type: "deny" },
        },
      ],
    },
    {
      policyKey: "kill-policy",
      activeVersion: 1,
      rules: [
        {
          id: "k1",
          status: "active",
          priority: 1,
          target: { service: "payments", resource: "checkout", action: "create" },
          effect: {
            type: "kill_switch",
            killSwitch: { service: "payments", reason: "incident" },
          },
        },
      ],
    },
  ]);

  const engine = createPolicyEngine({ getBundle: () => bundle });

  const out = engine.evaluate({
    target: { service: "payments", resource: "checkout", action: "create" },
    context: baseContext,
  });

  expect(out.decision).toBe("kill_switch");
  expect(out.policyKey).toBe("kill-policy");
  expect(out.ruleId).toBe("k1");
});

test("deny overrides allow even if allow has higher priority", () => {
  const bundle = makeBundle([
    {
      policyKey: "allow-policy",
      activeVersion: 1,
      rules: [
        {
          id: "a1",
          status: "active",
          priority: 999,
          target: { service: "auth", resource: "session", action: "create" },
          effect: { type: "allow" },
        },
      ],
    },
    {
      policyKey: "deny-policy",
      activeVersion: 1,
      rules: [
        {
          id: "d1",
          status: "active",
          priority: 1,
          target: { service: "auth", resource: "session", action: "create" },
          effect: { type: "deny" },
        },
      ],
    },
  ]);

  const engine = createPolicyEngine({ getBundle: () => bundle });

  const out = engine.evaluate({
    target: { service: "auth", resource: "session", action: "create" },
    context: baseContext,
  });

  expect(out.decision).toBe("deny");
});

test("throttle overrides allow and selects the most restrictive throttle", () => {
  const bundle = makeBundle([
    {
      policyKey: "throttle-weak",
      activeVersion: 1,
      rules: [
        {
          id: "t1",
          status: "active",
          priority: 10,
          target: { service: "api", resource: "public", action: "read" },
          effect: {
            type: "throttle",
            throttle: { limit: 20, windowSeconds: 60, key: "ctx.plan" }, // 0.33 r/s
          },
        },
      ],
    },
    {
      policyKey: "throttle-strong",
      activeVersion: 1,
      rules: [
        {
          id: "t2",
          status: "active",
          priority: 10,
          target: { service: "api", resource: "public", action: "read" },
          effect: {
            type: "throttle",
            throttle: { limit: 10, windowSeconds: 60, key: "ctx.plan" }, // 0.16 r/s (stricter)
          },
        },
      ],
    },
    {
      policyKey: "allow-policy",
      activeVersion: 1,
      rules: [
        {
          id: "a1",
          status: "active",
          priority: 999,
          target: { service: "api", resource: "public", action: "read" },
          effect: { type: "allow" },
        },
      ],
    },
  ]);

  const engine = createPolicyEngine({ getBundle: () => bundle });

  const out = engine.evaluate({
    target: { service: "api", resource: "public", action: "read" },
    context: baseContext,
  });

  expect(out.decision).toBe("throttle");

  if (out.decision !== "throttle") throw new Error("Expected throttle decision");
  
  expect(out.throttle.limit).toBe(10);
  expect(out.throttle.windowSeconds).toBe(60);
});

test("when AST is evaluated correctly", () => {
  const bundle = makeBundle([
    {
      policyKey: "conditional-deny",
      activeVersion: 1,
      rules: [
        {
          id: "r1",
          status: "active",
          priority: 1,
          target: { service: "payments", resource: "checkout", action: "create" },
          when: {
            op: "and",
            args: [
              { op: "eq", path: "ctx.plan", value: "free" },
              { op: "eq", path: "ctx.country", value: "ES" },
            ],
          },
          effect: { type: "deny" },
        },
      ],
    },
  ]);

  const engine = createPolicyEngine({ getBundle: () => bundle });

  const out = engine.evaluate({
    target: { service: "payments", resource: "checkout", action: "create" },
    context: baseContext,
  });

  expect(out.decision).toBe("deny");
  expect(out.reason).toBe("rule");
});

test("context validator rejects unknown keys (PII protection)", () => {
  const bundle = makeBundle([]);

  const engine = createPolicyEngine({
    getBundle: () => bundle,
    validateContext: true,
  });

  expect(() => {
    engine.evaluate({
      target: { service: "x", resource: "y", action: "z" },
      context: { email: "user@example.com" },
    });
  }).toThrow();
});
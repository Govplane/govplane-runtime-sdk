import { createPolicyEngine } from "../../src/engine/createPolicyEngine.js";

function makeBundle() {
  return {
    schemaVersion: 1,
    orgId: "org_dev",
    projectId: "prj_web",
    env: "prod",
    generatedAt: "2026-01-01T00:00:00.000Z",
    policies: [
      {
        policyKey: "p1",
        activeVersion: 1,
        rules: [
          {
            id: "r1",
            status: "active",
            priority: 1,
            target: { service: "api", resource: "public", action: "read" },
            effect: { type: "deny" },
          },
        ],
      },
    ],
  };
}

test("budget limits sampled traces", () => {
  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    traceDefaults: {
      sampling: 1, // always sample
      mode: "compact",
      budget: { maxTraces: 2, windowMs: 60_000 },
    },
  });

  const input = { target: { service: "api", resource: "public", action: "read" } };

  const a = (engine as any).evaluateWithTrace(input);
  const b = (engine as any).evaluateWithTrace(input);
  const c = (engine as any).evaluateWithTrace(input);

  expect(a.trace).toBeDefined();
  expect(b.trace).toBeDefined();
  expect(c.trace).toBeUndefined(); // blocked by budget
});

test("force bypasses budget", () => {
  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    traceDefaults: {
      sampling: 1,
      mode: "compact",
      budget: { maxTraces: 0, windowMs: 60_000 },
    },
  });

  const input = { target: { service: "api", resource: "public", action: "read" } };
  const out = (engine as any).evaluateWithTrace(input, { force: true });

  expect(out.trace).toBeDefined();
  expect(out.trace.sampled).toBe("forced");
  expect(out.trace.traceId).toBeTruthy();
});
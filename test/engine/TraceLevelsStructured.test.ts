import { createPolicyEngine } from "../../src/engine/createPolicyEngine.js";
import { toStructuredTraceEvent } from "../../src/engine/toStructuredTrace.js";

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

test("level=off never returns trace", () => {
  const engine = createPolicyEngine({ getBundle: () => makeBundle() as any });
  const out: any = (engine as any).evaluateWithTrace(
    { target: { service: "api", resource: "public", action: "read" } },
    { level: "off", sampling: 1 },
  );
  expect(out.trace).toBeUndefined();
});

test("level=errors traces only on deny/kill", () => {
  const engine = createPolicyEngine({ getBundle: () => makeBundle() as any });
  const out: any = (engine as any).evaluateWithTrace(
    { target: { service: "api", resource: "public", action: "read" } },
    { level: "errors", sampling: 0 },
  );
  expect(out.decision).toBe("deny");
  expect(out.trace).toBeDefined();
});

test("structured trace JSON is stable and PII-safe", () => {
  const engine = createPolicyEngine({ getBundle: () => makeBundle() as any });
  const out: any = (engine as any).evaluateWithTrace(
    { target: { service: "api", resource: "public", action: "read" } },
    { level: "errors", sampling: 0 },
  );

  const evt = toStructuredTraceEvent({ level: "errors", decision: out, trace: out.trace });
  expect(evt.v).toBe(1);
  expect(evt.traceId).toBeTruthy();
  expect((evt as any).context).toBeUndefined(); // ensure no context leaks
});

test("a signal_missing trace event carries no context either", () => {
  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    validateContext: false,
    signals: { required: ["riskScore"] },
  });
  const out: any = (engine as any).evaluateWithTrace(
    { target: { service: "api", resource: "public", action: "read" }, context: { secret: 1 } },
    { level: "errors", sampling: 0 },
  );

  const evt = toStructuredTraceEvent({ level: "errors", decision: out, trace: out.trace });
  expect(evt.reason).toBe("signal_missing");
  expect(JSON.stringify(evt)).not.toContain("secret");
  expect((evt as any).missingSignals).toBeUndefined();
});
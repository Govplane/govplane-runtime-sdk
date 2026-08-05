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

test("traceSinkAsync is fire-and-forget and receives events", async () => {
  const seen: any[] = [];

  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    traceDefaults: { level: "errors" },
    traceSinkAsync: async (evt) => {
      seen.push(evt);
    },
    traceQueueMax: 10,
    traceQueueDropPolicy: "drop_new",
  });

  const out: any = (engine as any).evaluateWithTrace({
    target: { service: "api", resource: "public", action: "read" },
  });

  expect(out.decision).toBe("deny");

  // allow microtask drain
  await (engine as any).flushTraces();

  expect(seen.length).toBe(1);
  expect(seen[0].traceId).toBeTruthy();
  expect(seen[0].decision).toBe("deny");
});

test("trace queue drop_new drops when full", async () => {
  const seen: any[] = [];

  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    traceDefaults: { level: "errors" },
    traceSinkAsync: async (evt) => {
      // slow sink to keep queue occupied
      await new Promise((r) => setTimeout(r, 10));
      seen.push(evt);
    },
    traceQueueMax: 1,
    traceQueueDropPolicy: "drop_new",
  });

  // enqueue multiple traces quickly
  for (let i = 0; i < 5; i++) {
    (engine as any).evaluateWithTrace({
      target: { service: "api", resource: "public", action: "read" },
    });
  }

    await (engine as any).flushTraces();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThan(5);
});
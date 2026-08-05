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

test("traceSink receives structured trace event when trace is produced", () => {
  const events: any[] = [];

  const engine = createPolicyEngine({
    getBundle: () => makeBundle() as any,
    traceDefaults: { level: "errors" },
    traceSink: (evt) => events.push(evt),
  });

  const out: any = (engine as any).evaluateWithTrace({
    target: { service: "api", resource: "public", action: "read" },
  });

  expect(out.decision).toBe("deny");
  expect(events.length).toBe(1);
  expect(events[0].v).toBe(1);
  expect(events[0].traceId).toBeTruthy();
  expect(events[0].decision).toBe("deny");
  expect(events[0].level).toBe("errors");
  expect(events[0].target.service).toBe("api");
});
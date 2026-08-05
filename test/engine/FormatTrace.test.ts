import { formatTrace } from "../../src/engine/formatTrace.js";

test("formatTrace compact single-line", () => {
  const trace: any = {
    traceId: "t1",
    sampled: "random",
    summary: {
      policiesSeen: 1,
      rulesSeen: 2,
      matched: 1,
      considered: { allow: 0, deny: 1, throttle: 0, kill_switch: 0 },
    },
    winner: {
      policyKey: "p1",
      ruleId: "r1",
      effectType: "deny",
      priority: 10,
    },
  };

  const out = formatTrace(trace);
  expect(out.includes("traceId=t1")).toBe(true);
  expect(out.includes("winner")).toBe(true);
});
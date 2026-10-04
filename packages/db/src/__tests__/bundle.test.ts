// The ngram-135m bundle (D9) must carry exactly the mock loop, so splice replays the same timeline
// the mock api serves — and lived-in parity holds after import (ids come back via idHints).
import { describe, expect, it } from "vitest";
import { deriveSegments } from "../derive";
import { report as reportFixture, run as run135, runEvents, snapshots as snapshots135 } from "@fabric/fixtures/run";
import { recordings } from "@fabric/fixtures/recordings";

const bundle = recordings["ngram-135m"];

describe("ngram-135m bundle", () => {
  it("exists and is labelled illustrative", () => {
    expect(bundle.kind).toBe("illustrative");
    expect(bundle.run.idHint).toBe(run135.id);
    expect(bundle.run.durationS).toBe(run135.durationS);
    expect(bundle.run.status).toBe("accepted");
  });

  it("events match the fixture log in order, t, type, actor and payload", () => {
    expect(bundle.events).toHaveLength(runEvents.length);
    for (const [i, e] of bundle.events.entries()) {
      const fixture = runEvents[i];
      expect({ t: e.t, type: e.type, actorAgentId: e.actorAgentId, payload: e.payload }).toEqual({
        t: fixture.t,
        type: fixture.type,
        actorAgentId: fixture.actorAgentId,
        payload: fixture.payload,
      });
    }
  });

  it("derived segments equal the fixture's precomputed ones (RUN-7 through the bundle)", () => {
    expect(deriveSegments(bundle.events, bundle.run.durationS)).toEqual(run135.segments);
  });

  it("snapshots carry idHints for every fixture snapshot", () => {
    expect(bundle.snapshots.map((s) => s.idHint)).toEqual(snapshots135.map((s) => s.id));
  });

  it("the report is the fixture's, labelled illustrative, ids stripped", () => {
    const { idHint, ...body } = bundle.report;
    const { id: fixtureId, runId: _fixtureRunId, ...fixtureBody } = reportFixture;
    expect(idHint).toBe(fixtureId);
    expect(body).toEqual({ ...fixtureBody, kind: "illustrative" });
  });

  it("every artifact.created event has a bundle artifact", () => {
    const names = runEvents.filter((e) => e.type === "artifact.created").map((e) => (e.payload as { name: string }).name);
    expect(bundle.artifacts.map((a) => a.name)).toEqual(names);
  });
});

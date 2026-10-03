// The mock's createProject id rule, reused for tasks and projects.
import { describe, expect, it } from "vitest";
import { slugId } from "../writer";

describe("slugId", () => {
  it("lowercases and dash-slugs", () => {
    expect(slugId("Engram on small models")).toBe("engram-on-small-models");
    expect(slugId("  n-gram / Engram  ")).toBe("n-gram-engram");
  });
  it("falls back to 'project' for empty slugs", () => {
    expect(slugId("???")).toBe("project");
  });
});

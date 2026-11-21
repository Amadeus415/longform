import { describe, expect, it } from "vitest";
import { parseChapters } from "../src/lib/chapters";

describe("parseChapters", () => {
  it("reads timestamps at the start of lines", () => {
    const description = `Thanks for watching!

TIMESTAMPS:
0:00 - Introduction
(12:30) Scaling laws
1:04:20 — The future of AI
1:59:59 Outro`;
    expect(parseChapters(description)).toEqual([
      [0, "Introduction"],
      [750, "Scaling laws"],
      [3860, "The future of AI"],
      [7199, "Outro"],
    ]);
  });

  it("reads timestamps at the end of lines", () => {
    expect(parseChapters("Intro 0:00\nPart one - 5:10\nPart two (10:00)")).toEqual([
      [0, "Intro"],
      [310, "Part one"],
      [600, "Part two"],
    ]);
  });

  it("needs at least three ascending chapters", () => {
    expect(parseChapters("0:00 Intro\n5:00 End")).toEqual([]);
    expect(parseChapters("0:00 A\n5:00 B\n3:00 C\n9:00 D")).toEqual([[0, "A"], [300, "B"], [540, "D"]]);
  });

  it("ignores timestamps in the middle of sentences", () => {
    expect(parseChapters("We recorded this at 10:30 in the morning\nAnd again at 11:45 and 12:00")).toEqual([]);
  });
});

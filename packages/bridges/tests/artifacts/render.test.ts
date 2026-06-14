import { describe, expect, test } from "bun:test";
import type { ArtifactRecord } from "../../src/artifacts/index.ts";
import { type ArtifactsConfig, Text } from "../../src/artifacts/render.ts";

const config: ArtifactsConfig = {
  spillBytes: 30720,
  headLines: 40,
  tailLines: 20,
  skipTools: ["artifact"],
  maxAgeDays: 7,
  retrieveLines: 200,
};

function record(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return { id: "deadbeef", toolName: "bash", bytes: 1000, lines: 100, ts: Date.now(), ...over };
}

describe("splitLines", () => {
  test("strips a single trailing newline", () => {
    expect(Text.splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("keeps interior blank lines and trailing content", () => {
    expect(Text.splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  test("does not drop sole empty string", () => {
    expect(Text.splitLines("")).toEqual([""]);
  });

  test("only strips one trailing newline", () => {
    expect(Text.splitLines("a\n\n")).toEqual(["a", ""]);
  });
});

describe("formatBytes", () => {
  test("negative and non-finite become 0 B", () => {
    expect(Text.formatBytes(-1)).toBe("0 B");
    expect(Text.formatBytes(Number.NaN)).toBe("0 B");
    expect(Text.formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  test("below 1024 rounds to whole bytes", () => {
    expect(Text.formatBytes(0)).toBe("0 B");
    expect(Text.formatBytes(512.4)).toBe("512 B");
    expect(Text.formatBytes(1023)).toBe("1023 B");
  });

  test("exactly 1024 is 1.0 KB", () => {
    expect(Text.formatBytes(1024)).toBe("1.0 KB");
  });

  test("one decimal below 100 of a unit", () => {
    expect(Text.formatBytes(1536)).toBe("1.5 KB");
  });

  test("rounds to integer at or above 100 of a unit", () => {
    expect(Text.formatBytes(100 * 1024)).toBe("100 KB");
    expect(Text.formatBytes(150 * 1024)).toBe("150 KB");
  });

  test("steps up through MB", () => {
    expect(Text.formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("utf8Head", () => {
  test("returns unclipped when within cap", () => {
    expect(Text.utf8Head("hello", 10)).toEqual({ text: "hello", clipped: false });
  });

  test("flags clipped exactly at boundary equal length is not clipped", () => {
    const text = "abcde";
    expect(Text.utf8Head(text, 5)).toEqual({ text, clipped: false });
  });

  test("trims into multibyte continuation bytes", () => {
    const text = "aéb";
    const clip = Text.utf8Head(text, 2);
    expect(clip.clipped).toBe(true);
    expect(clip.text).toBe("a");
  });

  test("floors and clamps negative cap to zero", () => {
    expect(Text.utf8Head("abc", -5)).toEqual({ text: "", clipped: true });
  });
});

describe("utf8Tail", () => {
  test("returns unclipped when within cap", () => {
    const text = "abc";
    expect(Text.utf8Tail(text, 10)).toEqual({ text, clipped: false });
  });

  test("trims leading continuation bytes for a valid boundary", () => {
    const text = "aéb";
    const clip = Text.utf8Tail(text, 2);
    expect(clip.clipped).toBe(true);
    expect(clip.text).toBe("b");
  });
});

describe("formatAge", () => {
  test("unknown for non-finite or non-positive", () => {
    expect(Text.formatAge(0)).toBe("unknown");
    expect(Text.formatAge(-5)).toBe("unknown");
    expect(Text.formatAge(Number.NaN)).toBe("unknown");
  });

  test("just now under a minute", () => {
    expect(Text.formatAge(Date.now() - 1000)).toBe("just now");
  });

  test("minutes bucket", () => {
    expect(Text.formatAge(Date.now() - 5 * 60000)).toBe("5m");
  });

  test("hours bucket", () => {
    expect(Text.formatAge(Date.now() - 3 * 3600000)).toBe("3h");
  });

  test("days bucket", () => {
    expect(Text.formatAge(Date.now() - 2 * 86400000)).toBe("2d");
  });

  test("future timestamps clamp to just now", () => {
    expect(Text.formatAge(Date.now() + 100000)).toBe("just now");
  });
});

describe("buildReplacement", () => {
  test("head/tail split with omission shape", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    const out = Text.buildReplacement(text, record({ bytes: Buffer.byteLength(text), lines: 200 }), config);
    const parts = out.split("\n\n");
    expect(parts.length).toBe(3);
    expect(parts[0].split("\n")[0]).toBe("line1");
    expect(parts[1]).toContain("[output spilled to artifact deadbeef:");
    expect(parts[1]).toContain("200 lines total]");
    expect(parts[1]).toContain("showing first 40 and last 20 lines; lines 41-180 (140 lines) omitted");
    expect(parts[1]).toContain('{"id":"list"} lists all session artifacts');
    expect(parts[2].split("\n").at(-1)).toBe("line200");
  });

  test("overlap path puts all lines in head and tail count zero", () => {
    const text = Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n");
    const out = Text.buildReplacement(text, record({ lines: 50 }), config);
    const parts = out.split("\n\n");
    expect(parts.length).toBe(2);
    expect(parts[1]).toContain("all lines shown above but long lines were clipped; the full text is stored");
  });

  test("singular line wording", () => {
    const text = "single";
    const out = Text.buildReplacement(text, record({ lines: 1 }), config);
    expect(out).toContain("1 line total]");
  });

  test("clips head and tail windows when long", () => {
    const big = "x".repeat(40000);
    const text = Array.from({ length: 100 }, () => big).join("\n");
    const cfg: ArtifactsConfig = { ...config, headLines: 2, tailLines: 2, spillBytes: 8192 };
    const out = Text.buildReplacement(text, record({ lines: 100 }), cfg);
    expect(out).toContain("[head window clipped at");
    expect(out).toContain("[tail window clipped at");
  });

  test("omitted exactly one line uses singular", () => {
    const text = Array.from({ length: 61 }, (_, i) => `r${i}`).join("\n");
    const out = Text.buildReplacement(text, record({ lines: 61 }), config);
    expect(out).toContain("(1 line) omitted");
  });
});

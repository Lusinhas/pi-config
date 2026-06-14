import { describe, expect, test } from "bun:test";
import { Catalog } from "../../src/styles/catalog.ts";
import type { Style, StyleError } from "../../src/styles/parse.ts";
import { CompletionRenderer, MenuRenderer, Renderer } from "../../src/styles/render.ts";

function style(name: string, description: string, source: "preset" | "user" = "preset", body = "the body"): Style {
  return { name, description, body, source, path: `/p/${name}.md` };
}

function catalog(styles: Style[], errors: StyleError[] = []): Catalog {
  const map = new Map<string, Style>();

  for (const s of styles) {
    map.set(s.name.toLowerCase(), s);
  }

  return new Catalog(map, errors);
}

const renderer = new Renderer();

describe("Renderer.clip", () => {
  test("collapses whitespace runs and trims", () => {
    expect(renderer.clip("  a   b\n\tc  ", 80)).toBe("a b c");
  });

  test("returns as-is when within max", () => {
    expect(renderer.clip("short", 80)).toBe("short");
  });

  test("clips with ellipsis when over max", () => {
    expect(renderer.clip("abcdefghij", 8)).toBe("abcde...");
  });

  test("handles tiny max via Math.max(0, max-3)", () => {
    expect(renderer.clip("abcdefg", 2)).toBe("...");
  });
});

describe("Renderer.buildAddendum", () => {
  test("incoming empty yields addendum alone", () => {
    const result = renderer.buildAddendum(style("foo", "d", "preset", "body here"), "");
    expect(result).toBe("## Output style: foo\n\nbody here");
  });

  test("non-empty incoming joins with two newlines", () => {
    const result = renderer.buildAddendum(style("foo", "d", "preset", "B"), "PROMPT");
    expect(result).toBe("PROMPT\n\n## Output style: foo\n\nB");
  });

  test("uses original-case name", () => {
    const result = renderer.buildAddendum(style("MyStyle", "d", "user", "x"), "");
    expect(result).toBe("## Output style: MyStyle\n\nx");
  });
});

describe("Renderer.completions", () => {
  test("lists catalog styles in discovery order then off", () => {
    const cat = catalog([style("alpha", "first"), style("beta", "second")]);
    const items = renderer.completions(cat, "");
    expect(items?.map((i) => i.value)).toEqual(["alpha", "beta", "off"]);
    expect(items?.[2].description).toBe("Disable the output style addendum");
  });

  test("filters by lowercase startsWith on value", () => {
    const cat = catalog([style("alpha", "a"), style("Beta", "b")]);
    const items = renderer.completions(cat, "BE");
    expect(items?.map((i) => i.value)).toEqual(["Beta"]);
  });

  test("returns null when no match (not empty array)", () => {
    const cat = catalog([style("alpha", "a")]);
    expect(renderer.completions(cat, "zzz")).toBeNull();
  });

  test("off matches o prefix", () => {
    const cat = catalog([]);
    expect(renderer.completions(cat, "o")?.map((i) => i.value)).toEqual(["off"]);
  });

  test("descriptions clipped at 80", () => {
    const long = "x".repeat(200);
    const cat = catalog([style("alpha", long)]);
    const items = renderer.completions(cat, "alpha");
    expect(items?.[0].description?.length).toBe(80);
  });
});

describe("Renderer.selectMenu", () => {
  test("marks active with star, others with two spaces, off last", () => {
    const cat = catalog([style("alpha", "a", "preset"), style("beta", "b", "user")]);
    const menu = renderer.selectMenu(cat, "beta");
    expect(menu.options[0]).toBe("  alpha (preset) - a");
    expect(menu.options[1]).toBe("* beta (user) - b");
    expect(menu.options[2]).toBe("  off - disable output style");
    expect(menu.values).toEqual(["alpha", "beta", "off"]);
  });

  test("marks off when active is off (case-insensitive)", () => {
    const cat = catalog([style("alpha", "a")]);
    const menu = renderer.selectMenu(cat, "OFF");
    expect(menu.options[1]).toBe("* off - disable output style");
  });

  test("clips description at 100 in menu", () => {
    const cat = catalog([style("alpha", "y".repeat(300))]);
    const menu = renderer.selectMenu(cat, "alpha");
    expect(menu.options[0]).toBe(`* alpha (preset) - ${"y".repeat(97)}...`);
  });
});

describe("Renderer.formatNotices", () => {
  test("returns null when no errors and active present", () => {
    const cat = catalog([style("default", "d")]);
    expect(renderer.formatNotices(cat, "default")).toBeNull();
  });

  test("returns null when active is off and no errors", () => {
    const cat = catalog([style("default", "d")]);
    expect(renderer.formatNotices(cat, "off")).toBeNull();
  });

  test("singular file wording when one error", () => {
    const cat = catalog([], [{ path: "/p/a.md", message: "bad" }]);
    expect(renderer.formatNotices(cat, "off")).toBe("Styles: skipped 1 invalid style file:\n  /p/a.md: bad");
  });

  test("plural files wording when multiple errors", () => {
    const cat = catalog([], [
      { path: "/p/a.md", message: "bad" },
      { path: "/p/b.md", message: "worse" },
    ]);
    const notices = renderer.formatNotices(cat, "off");
    expect(notices).toBe("Styles: skipped 2 invalid style files:\n  /p/a.md: bad\n  /p/b.md: worse");
  });

  test("missing active style notice (case-insensitive lookup)", () => {
    const cat = catalog([style("default", "d")]);
    expect(renderer.formatNotices(cat, "ghost")).toBe(
      'Styles: active style "ghost" was not found; no style addendum is being applied.',
    );
  });

  test("no missing-active notice when active resolves", () => {
    const cat = catalog([style("Default", "d")]);
    expect(renderer.formatNotices(cat, "default")).toBeNull();
  });

  test("combines errors and missing-active notice", () => {
    const cat = catalog([style("default", "d")], [{ path: "/p/x.md", message: "oops" }]);
    const notices = renderer.formatNotices(cat, "ghost");
    expect(notices).toBe(
      "Styles: skipped 1 invalid style file:\n  /p/x.md: oops\n" +
        'Styles: active style "ghost" was not found; no style addendum is being applied.',
    );
  });
});

describe("MenuRenderer", () => {
  const menus = new MenuRenderer();

  test("renders identical output to Renderer.selectMenu", () => {
    const cat = catalog([style("alpha", "a", "preset"), style("beta", "b", "user")]);
    expect(menus.render(cat, "beta")).toEqual(renderer.selectMenu(cat, "beta"));
  });

  test("clips description at 100", () => {
    const cat = catalog([style("alpha", "y".repeat(300))]);
    expect(menus.render(cat, "alpha").options[0]).toBe(`* alpha (preset) - ${"y".repeat(97)}...`);
  });
});

describe("CompletionRenderer", () => {
  const completer = new CompletionRenderer();

  test("renders identical output to Renderer.completions", () => {
    const cat = catalog([style("alpha", "first"), style("beta", "second")]);
    expect(completer.render(cat, "")).toEqual(renderer.completions(cat, ""));
  });

  test("clips description at 80", () => {
    const cat = catalog([style("alpha", "x".repeat(200))]);
    expect(completer.render(cat, "alpha")?.[0].description?.length).toBe(80);
  });
});

import { describe, expect, test } from "bun:test";
import {
  FooterController,
  type FooterComponent,
  type FooterHost,
  type ThemeLike,
  type TuiLike
} from "../../src/status/footer.ts";
import { composeLine } from "../../src/status/compose.ts";
import type { SegmentPart } from "../../src/status/index.ts";

const raw: ThemeLike = { fg: (_token, text) => text };
const paint = (token: string, text: string): string => raw.fg(token, text);

function part(text: string, token: string | null = null): SegmentPart {
  return { id: "model", text, token };
}

describe("composeLine", () => {
  test("empty parts yields empty string", () => {
    expect(composeLine([], " | ", 80, paint)).toBe("");
  });

  test("joins parts with separator when within width", () => {
    const line = composeLine([part("a"), part("bb"), part("ccc")], " | ", 80, paint);

    expect(line).toBe("a | bb | ccc");
  });

  test("drops from the end when over width", () => {
    const parts = [part("aaaa"), part("bbbb"), part("cccc")];
    const keepTwo = composeLine(parts, " | ", 11, paint);

    expect(keepTwo).toBe("aaaa | bbbb");

    const keepOne = composeLine(parts, " | ", 10, paint);

    expect(keepOne).toBe("aaaa");
  });

  test("clips a single remaining part exceeding width", () => {
    const line = composeLine([part("aaaaaaaaaa")], "|", 4, paint);

    expect(line).toBe("aaa…");
  });

  test("non-finite or non-positive width defaults to 80", () => {
    const long = "x".repeat(90);
    const line = composeLine([part(long)], "|", Number.NaN, paint);

    expect([...line].length).toBe(80);
    expect(line.endsWith("…")).toBe(true);
  });

  test("separator width measured in code points", () => {
    const parts = [part("aa"), part("bb"), part("cc")];
    const line = composeLine(parts, " │ ", 8, paint);

    expect(line).toBe("aa │ bb");
  });

  test("keeps at least one part even if it overflows", () => {
    const parts = [part("aaaaaa"), part("bbbbbb")];
    const line = composeLine(parts, " | ", 3, paint);

    expect(line).toBe("aa…");
  });

  test("paints non-null tokens through theme", () => {
    const theme: ThemeLike = { fg: (token, text) => `[${token}:${text}]` };
    const localPaint = (token: string, text: string): string => theme.fg(token, text);
    const line = composeLine([part("m", "accent"), part("plain", null)], " | ", 80, localPaint);

    expect(line).toBe("[accent:m][dim: | ]plain");
  });
});

class FakeTui implements TuiLike {
  renders = 0;

  requestRender(): void {
    this.renders += 1;
  }
}

class FakeHost implements FooterHost {
  factory: unknown = "unset";
  setFooterCalls = 0;

  setFooter(factory: unknown): void {
    this.setFooterCalls += 1;
    this.factory = factory;
  }
}

describe("FooterController", () => {
  test("install sets footer and is idempotent", () => {
    const host = new FakeHost();
    const controller = new FooterController(" | ", () => [part("a")]);

    controller.install(host);
    expect(controller.installed).toBe(true);
    expect(host.setFooterCalls).toBe(1);

    controller.install(host);
    expect(host.setFooterCalls).toBe(1);
  });

  test("install leaves installed false when host throws", () => {
    const host: FooterHost = {
      setFooter: () => {
        throw new Error("boom");
      }
    };
    const controller = new FooterController(" | ", () => [part("a")]);

    controller.install(host);
    expect(controller.installed).toBe(false);
  });

  test("render memoizes by line and width", () => {
    let snapshot: SegmentPart[] = [part("a"), part("b")];
    const controller = new FooterController(" | ", () => snapshot);
    const tui = new FakeTui();
    const component = controller.factory(tui, raw) as FooterComponent;

    const first = component.render(80);

    expect(first).toEqual(["a | b"]);

    const cached = component.render(80);

    expect(cached).toBe(first);

    snapshot = [part("c")];
    const next = component.render(80);

    expect(next).toEqual(["c"]);
  });

  test("render returns [] when the snapshot throws", () => {
    const controller = new FooterController(" | ", () => {
      throw new Error("snapshot failed");
    });
    const component = controller.factory(new FakeTui(), raw) as FooterComponent;

    expect(component.render(80)).toEqual([]);
  });

  test("empty line yields no rows", () => {
    const controller = new FooterController(" | ", () => []);
    const component = controller.factory(new FakeTui(), raw) as FooterComponent;

    expect(component.render(80)).toEqual([]);
  });

  test("refresh requests render only when installed with a tui", () => {
    const controller = new FooterController(" | ", () => [part("a")]);
    const tui = new FakeTui();

    controller.refresh();
    expect(tui.renders).toBe(0);

    controller.factory(tui, raw);
    controller.refresh();
    expect(tui.renders).toBe(1);
  });

  test("uninstall clears footer and tui", () => {
    const host = new FakeHost();
    const controller = new FooterController(" | ", () => [part("a")]);
    const tui = new FakeTui();

    controller.install(host);
    controller.factory(tui, raw);
    controller.uninstall(host);

    expect(controller.installed).toBe(false);
    expect(host.factory).toBeUndefined();

    controller.refresh();
    expect(tui.renders).toBe(0);
  });

  test("paint falls back to raw text on throwing or empty theme", () => {
    const theme: ThemeLike = {
      fg: (token, text) => {
        if (token === "accent") {
          throw new Error("boom");
        }

        return token === "dim" ? "" : text;
      }
    };
    const controller = new FooterController("|", () => [part("m", "accent")]);
    const component = controller.factory(new FakeTui(), theme) as FooterComponent;

    expect(component.render(80)).toEqual(["m"]);
  });
});

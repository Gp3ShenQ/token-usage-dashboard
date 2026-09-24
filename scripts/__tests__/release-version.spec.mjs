import { describe, expect, it } from "vitest";
import { bumpLevel, compare, nextVersion, parse } from "../release-version.mjs";

const next = (latestTag, messages, packageVersion = "0.1.0") => nextVersion({ latestTag, packageVersion, messages }).version;

describe("release version", () => {
  it("maps commit types to bump levels", () => {
    expect(bumpLevel("feat(widget): 新增")).toBe("minor");
    expect(bumpLevel("fix: 修正")).toBe("patch");
    expect(bumpLevel("refactor(router): 調整")).toBe("patch");
    expect(bumpLevel("perf: 加速")).toBe("patch");
    expect(bumpLevel("docs: 文件")).toBe("patch");
    expect(bumpLevel("chore(deps): bump")).toBe("patch");
    expect(bumpLevel("feat!: 移除舊設定")).toBe("major");
    expect(bumpLevel("fix: 修正\n\nBREAKING CHANGE: 格式改變")).toBe("major");
    expect(bumpLevel("[新增] 非慣例訊息")).toBe("patch");
    expect(bumpLevel("Merge pull request #1 from x/dev")).toBe("patch");
  });

  it("releases every merge, using the highest bump since the latest tag", () => {
    expect(next("v1.2.3", ["docs: a", "fix: b"])).toBe("1.2.4");
    expect(next("v1.2.3", ["fix: a", "feat: b"])).toBe("1.3.0");
    expect(next("v1.2.3", ["feat!: a", "fix: b"])).toBe("2.0.0");
    expect(next("v1.2.3", ["docs: a", "ci: b"])).toBe("1.2.4");
    expect(next("v1.2.3", [])).toBeNull();
  });

  it("keeps breaking changes on MINOR before 1.0.0", () => {
    expect(next("v0.1.0", ["feat!: a"])).toBe("0.2.0");
  });

  it("lets package.json request a higher version", () => {
    expect(next("v0.1.0", ["docs: a"], "1.0.0")).toBe("1.0.0");
    expect(next("v0.1.0", [], "0.2.0-beta.1")).toBe("0.2.0-beta.1");
    expect(next("v0.3.0", ["fix: a"], "0.1.0")).toBe("0.3.1");
  });

  it("finishes a prerelease on the next releasable commit", () => {
    expect(next("v0.2.0-beta.1", ["fix: a"])).toBe("0.2.0");
  });

  it("rejects invalid package.json versions", () => {
    expect(() => next("v0.1.0", [], "1.0")).toThrow();
  });

  it("orders prereleases per SemVer", () => {
    const c = (a, b) => Math.sign(compare(parse(a), parse(b)));
    expect(c("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(c("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(c("0.2.0", "0.10.0")).toBe(-1);
  });
});

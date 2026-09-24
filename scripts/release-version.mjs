// Computes the next release version from Conventional Commits since the latest v* tag.
// Any new commit releases at least a PATCH; feat and breaking changes raise it further.
// package.json only overrides the result when it names a higher, unreleased version.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const HEADER = /^(\w+)(?:\([^)]*\))?(!)?:\s/;
const LEVELS = ["patch", "minor", "major"];

export function parse(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
}

export function format(version) {
  return version.core.join(".") + (version.pre.length ? "-" + version.pre.join(".") : "");
}

export function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  // A release outranks any prerelease of the same core version.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function bumpLevel(message) {
  const header = HEADER.exec(message);
  if (!header) return "patch";
  if (header[2] || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
  if (header[1] === "feat") return "minor";
  return "patch";
}

export function bump(version, level) {
  const [major, minor, patch] = version.core;
  // Before 1.0.0 a breaking change only bumps MINOR.
  if (level === "major" && major === 0) level = "minor";
  // Finishing a prerelease releases its core version as-is.
  if (version.pre.length) return { core: [major, minor, patch], pre: [] };
  if (level === "major") return { core: [major + 1, 0, 0], pre: [] };
  if (level === "minor") return { core: [major, minor + 1, 0], pre: [] };
  return { core: [major, minor, patch + 1], pre: [] };
}

export function nextVersion({ latestTag, packageVersion, messages }) {
  const requested = parse(packageVersion);
  if (!requested) throw new Error(`package.json version "${packageVersion}" is not valid SemVer.`);
  const latest = latestTag ? parse(latestTag.slice(1)) : null;
  if (!latest || compare(requested, latest) > 0) return { version: format(requested), reason: "package.json" };
  if (!messages.length) return { version: null, reason: "no new commits" };
  const level = messages.map(bumpLevel).reduce((a, b) => LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a, "patch");
  return { version: format(bump(latest, level)), reason: level };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
  const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  const latestTag = git("tag", "--list", "v*").split(/\r?\n/).filter(tag => parse(tag.slice(1)))
    .sort((a, b) => compare(parse(b.slice(1)), parse(a.slice(1))))[0];
  const range = latestTag ? [`${latestTag}..HEAD`] : ["HEAD"];
  const messages = git("log", "--format=%B%x1e", ...range).split("\x1e").map(m => m.trim()).filter(Boolean);
  const { version, reason } = nextVersion({ latestTag, packageVersion, messages });
  console.log(version ? `Next release: v${version} (${reason})` : `No release: ${reason} since ${latestTag}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, version
      ? `release=true\nversion=${version}\ntag=v${version}\nprerelease=${version.includes("-") ? "--prerelease" : ""}\n`
      : "release=false\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
}

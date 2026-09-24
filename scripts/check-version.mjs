// Validates package.json version against existing v* tags; used by CI and the release workflow.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parse(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
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

function main() {
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  const current = parse(version);
  if (!current) throw new Error(`package.json version "${version}" is not valid SemVer.`);
  const tag = "v" + version;
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const exists = tags.includes(tag);
  const latest = tags.map(name => ({ name, parsed: parse(name.slice(1)) })).filter(item => item.parsed)
    .sort((a, b) => compare(b.parsed, a.parsed))[0];
  if (!exists && latest && compare(current, latest.parsed) < 0) {
    throw new Error(`package.json version ${version} is lower than the latest release ${latest.name}.`);
  }
  console.log(exists ? `${tag} already released; merging will not publish.` : `${tag} will be published on merge to main.`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `tag=${tag}\nexists=${exists}\nprerelease=${current.pre.length ? "--prerelease" : ""}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { JsonlTail } from "../tail.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

it("retains partial UTF-8 lines and reads only newly appended records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hud-tail-"));
  directories.push(directory);
  const file = path.join(directory, "test.jsonl");
  const bytes = Buffer.from(JSON.stringify({ text: "中文事件" }) + "\n");
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  await fs.writeFile(file, bytes.subarray(0, split));
  const tail = new JsonlTail();
  const records: unknown[] = [];
  await tail.read(file, split, record => records.push(record));
  expect(records).toEqual([]);
  await fs.appendFile(file, bytes.subarray(split));
  await tail.read(file, bytes.length, record => records.push(record));
  await tail.read(file, bytes.length, record => records.push(record));
  expect(records).toEqual([{ text: "中文事件" }]);
});

it("reports a corrupt line but continues with the next valid record", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hud-tail-"));
  directories.push(directory);
  const file = path.join(directory, "test.jsonl");
  const content = 'broken\n{"valid":true}\n';
  await fs.writeFile(file, content);
  const records: unknown[] = [];
  const valid = await new JsonlTail().read(file, Buffer.byteLength(content), record => records.push(record));
  expect(valid).toBe(false);
  expect(records).toEqual([{ valid: true }]);
});

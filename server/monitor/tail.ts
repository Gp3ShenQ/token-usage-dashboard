import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class JsonlTail {
  offset = 0;
  private pending = Buffer.alloc(0);
  private skippingLine = false;

  async read(filePath: string, size: number, accept: (record: any) => void): Promise<boolean> {
    if (size <= this.offset) return true;
    let valid = true;
    const stream = fs.createReadStream(filePath, { start: this.offset, end: size - 1 });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      this.offset += bytes.length;
      let buffer = Buffer.concat([this.pending, bytes]);
      let newline = buffer.indexOf(10);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline);
        if (!this.skippingLine && line.length <= MAX_LINE_BYTES && line.toString("utf8").trim()) {
          try { accept(JSON.parse(new StringDecoder("utf8").write(line))); }
          catch { valid = false; }
        } else if (this.skippingLine || line.length > MAX_LINE_BYTES) valid = false;
        this.skippingLine = false;
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(10);
      }
      if (buffer.length > MAX_LINE_BYTES) {
        this.skippingLine = true;
        this.pending = Buffer.alloc(0);
        valid = false;
      } else this.pending = Buffer.from(buffer);
    }
    return valid;
  }
}

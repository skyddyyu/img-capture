import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..', 'public', 'icon');
fs.mkdirSync(root, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return out;
}
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const inside = (x, y, a, b, c, d) => x >= a && y >= b && x <= c && y <= d;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xx = ((x + 0.5) / size) * 32,
        yy = ((y + 0.5) / size) * 32;
      const rounded =
        Math.hypot(Math.max(0, Math.abs(xx - 16) - 9), Math.max(0, Math.abs(yy - 16) - 9)) < 6;
      const white =
        inside(xx, yy, 8, 8, 13, 10) ||
        inside(xx, yy, 8, 8, 10, 13) ||
        inside(xx, yy, 19, 8, 24, 10) ||
        inside(xx, yy, 22, 8, 24, 13) ||
        inside(xx, yy, 8, 19, 10, 24) ||
        inside(xx, yy, 8, 22, 13, 24) ||
        inside(xx, yy, 22, 19, 24, 24) ||
        inside(xx, yy, 19, 22, 24, 24) ||
        inside(xx, yy, 14, 14, 18, 18);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set(white ? [255, 255, 255, 255] : [24, 107, 82, rounded ? 255 : 0], i);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    path.join(root, `${size}.png`),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
console.log('Generated local extension icons.');

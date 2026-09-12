/**
 * Minimal structurally-valid JPEG bytes for tests: SOI, a SOF0 marker carrying the requested
 * dimensions, optional padding, EOI. Enough for `jpegDimensions` and byte-size checks; not a
 * decodable image.
 */
export function fakeJpeg(width: number, height: number, pad = 0): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(pad, 0x42), Buffer.from([0xff, 0xd9])]);
}

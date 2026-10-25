'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { createZip, crc32 } = require('../public/zip');

// Reads the ZIP back the way an unzip tool would: end record, central
// directory, then each file's bytes, checking sizes and CRCs along the way.
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  assert.equal(cd + buf.readUInt32LE(eocd + 12), eocd, 'central directory ends where the end record starts');

  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(cd), 0x02014b50, 'central entry signature');
    const flags = buf.readUInt16LE(cd + 8);
    const method = buf.readUInt16LE(cd + 10);
    const crc = buf.readUInt32LE(cd + 16);
    const size = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const local = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);

    assert.equal(flags & 0x0800, 0x0800, 'UTF-8 flag');
    assert.equal(method, 0, 'stored');
    assert.equal(buf.readUInt32LE(local), 0x04034b50, 'local header signature');
    assert.equal(buf.readUInt32LE(local + 18), size, 'local and central sizes agree');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    files.push({ name, data });
    cd += 46 + nameLen;
  }
  return files;
}

test('crc32 matches the reference implementation', () => {
  const bytes = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(bytes), zlib.crc32(bytes));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a ZIP built here reads back with the same names and bytes', async () => {
  const zip = createZip();
  const a = Buffer.from('first file');
  const b = Buffer.alloc(100000, 0xab);
  const empty = Buffer.alloc(0);
  zip.add('01 - Artist - Song.mp3', a);
  zip.add('02 - Beyoncé – Halo (live).mp3', b);
  zip.add('03 - empty.mp3', empty);
  assert.equal(zip.count, 3);

  const blob = zip.finish();
  assert.equal(blob.type, 'application/zip');
  const files = readZip(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(files.map((f) => f.name), ['01 - Artist - Song.mp3', '02 - Beyoncé – Halo (live).mp3', '03 - empty.mp3']);
  assert.deepEqual(files[0].data, a);
  assert.deepEqual(files[1].data, b);
  assert.equal(files[2].data.length, 0);
});

test('an empty ZIP is still a valid archive', async () => {
  const blob = createZip().finish();
  assert.equal(blob.size, 22);
  assert.deepEqual(readZip(Buffer.from(await blob.arrayBuffer())), []);
});

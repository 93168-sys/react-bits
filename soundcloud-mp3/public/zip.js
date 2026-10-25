// Minimal ZIP writer. Files are stored without compression, which is right for
// MP3s because they are already compressed. Runs in the browser and in Node
// (the tests load it with require).
(function (root) {
  'use strict';

  var MAX_ENTRIES = 0xfffe;
  var MAX_BYTES = 0xfffffff0; // plain ZIP (no ZIP64) tops out near 4 GB

  var crcTable = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    var day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time, date: day };
  }

  function createZip() {
    var parts = [];
    var central = []; // for each file: its central directory record, then its name
    var count = 0;
    var offset = 0;
    var stamp = dosDateTime(new Date());
    var encoder = new TextEncoder();

    return {
      get count() {
        return count;
      },

      add: function (name, bytes) {
        if (count >= MAX_ENTRIES) throw new Error('Too many files for one ZIP.');
        if (offset + bytes.length > MAX_BYTES) throw new Error('The ZIP would be bigger than 4 GB.');

        var nameBytes = encoder.encode(name);
        var crc = crc32(bytes);

        var local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true); // version needed
        local.setUint16(6, 0x0800, true); // file names are UTF-8
        local.setUint16(8, 0, true); // stored, no compression
        local.setUint16(10, stamp.time, true);
        local.setUint16(12, stamp.date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, bytes.length, true);
        local.setUint32(22, bytes.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);

        var entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true); // version made by
        entry.setUint16(6, 20, true); // version needed
        entry.setUint16(8, 0x0800, true);
        entry.setUint16(10, 0, true);
        entry.setUint16(12, stamp.time, true);
        entry.setUint16(14, stamp.date, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, bytes.length, true);
        entry.setUint32(24, bytes.length, true);
        entry.setUint16(28, nameBytes.length, true);
        // extra length, comment length, disk number, internal and external attributes stay 0
        entry.setUint32(42, offset, true);
        central.push(new Uint8Array(entry.buffer), nameBytes);
        count++;

        parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
        offset += 30 + nameBytes.length + bytes.length;
      },

      finish: function () {
        var centralSize = 0;
        for (var i = 0; i < central.length; i++) centralSize += central[i].length;

        var end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, count, true);
        end.setUint16(10, count, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);

        return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
      },
    };
  }

  var api = { createZip: createZip, crc32: crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniZip = api;
})(typeof self !== 'undefined' ? self : this);

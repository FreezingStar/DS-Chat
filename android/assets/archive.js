/* Minimal ZIP reader (stored + deflate), no external dependency at runtime
   beyond the bundled fflate inflater. */
(function (global) {
  'use strict';

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function findEOCD(dv) {
    var len = dv.byteLength;
    var min = Math.max(0, len - 65557);
    for (var i = len - 22; i >= min; i--) {
      if (u32(dv, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function open(buffer) {
    var dv = new DataView(buffer);
    var eocd = findEOCD(dv);
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);
    var entries = {};
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (u32(dv, p) !== 0x02014b50) break;
      var method = u16(dv, p + 10);
      var compSize = u32(dv, p + 20);
      var size = u32(dv, p + 24);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var offset = u32(dv, p + 42);
      var name = new TextDecoder('utf-8').decode(new Uint8Array(buffer, p + 46, nameLen));
      entries[name] = { method: method, compSize: compSize, size: size, offset: offset };
      p += 46 + nameLen + extraLen + commentLen;
    }

    function bytes(name) {
      var e = entries[name];
      if (!e) return null;
      if (u32(dv, e.offset) !== 0x04034b50) throw new Error('ZIP 条目损坏');
      var nl = u16(dv, e.offset + 26);
      var el = u16(dv, e.offset + 28);
      var start = e.offset + 30 + nl + el;
      var raw = new Uint8Array(buffer, start, e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) {
        if (!global.fflate || !global.fflate.inflateSync) throw new Error('解压组件缺失');
        return global.fflate.inflateSync(raw);
      }
      throw new Error('不支持的压缩方式');
    }

    return {
      names: function () { return Object.keys(entries); },
      has: function (name) { return !!entries[name]; },
      bytes: bytes,
      text: function (name) {
        var b = bytes(name);
        return b ? new TextDecoder('utf-8').decode(b) : null;
      },
      json: function (name) {
        var t = this.text(name);
        if (!t) return null;
        try { return JSON.parse(t); } catch (e) { return null; }
      }
    };
  }

  global.DSArchive = { open: open };
})(window);

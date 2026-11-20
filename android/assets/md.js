/* Tiny markdown renderer with light syntax highlighting, tuned for chat streaming.
   Everything is HTML-escaped before it reaches the DOM. */
(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  var KW = {
    python: 'def class return if elif else for while in not and or import from as with try except finally lambda None True False pass break continue yield raise global nonlocal assert del is async await self',
    js: 'function const let var return if else for while class new this typeof instanceof import export default async await try catch finally throw switch case break continue null undefined true false extends super yield do in of void delete',
    sh: 'if then else elif fi for while do done case esac function echo export local return exit cd source set',
    json: 'true false null',
    yaml: 'true false null yes no on off',
    sql: 'select from where insert into values update delete join left right inner outer group by order limit offset create table drop alter index and or not null as distinct count sum avg min max',
    c: 'if else for while do switch case default return break continue struct typedef enum union static const void int char float double long short unsigned signed sizeof goto extern volatile inline class public private protected new delete this nullptr true false using namespace template typename virtual override auto bool'
  };
  var LANG_ALIAS = {
    py: 'python', python3: 'python',
    javascript: 'js', jsx: 'js', mjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
    cpp: 'c', 'c++': 'c', csharp: 'c', cs: 'c', java: 'c', kotlin: 'c', kt: 'c', swift: 'c', go: 'c', rust: 'c', rs: 'c', objc: 'c',
    yml: 'yaml', json5: 'json', sqlite: 'sql'
  };
  function keywordsFor(lang) {
    var key = LANG_ALIAS[lang] || lang;
    return KW[key] || null;
  }

  function highlight(code, lang) {
    var kw = keywordsFor(lang);
    if (!kw || !code) return esc(code);
    var comment = (typeof lang === 'string' && /^(python|sh|yaml)$/.test(LANG_ALIAS[lang] || lang))
      ? '#[^\\n]*'
      : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
    var re = new RegExp(
      '(' + comment + ')' +
      '|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)' +
      '|(\\b\\d+(?:\\.\\d+)?\\b)' +
      '|(\\b(?:' + kw.replace(/\s+/g, '|') + ')\\b)' +
      '|(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())', 'g');
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += '<span class="tok-com">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tok-str">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tok-num">' + esc(m[3]) + '</span>';
      else if (m[4]) out += '<span class="tok-key">' + esc(m[4]) + '</span>';
      else if (m[5]) out += '<span class="tok-fn">' + esc(m[5]) + '</span>';
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  var listRe = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var fenceRe = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)\s*$/;
  var headingRe = /^ {0,3}(#{1,6})\s+(.*)$/;
  var hrRe = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
  var quoteRe = /^\s{0,3}>\s?/;
  var tableSepRe = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  function inline(text) {
    var codes = [];
    text = esc(text);
    text = text.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    text = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, label, url) {
      if (!/^https?:\/\//i.test(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    text = text.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return '<code>' + codes[+i] + '</code>';
    });
    return text;
  }

  function parseList(lines, start) {
    var m0 = listRe.exec(lines[start]);
    var ordered = /\d/.test(m0[2]);
    var baseIndent = m0[1].replace(/\t/g, '  ').length;
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>';
    var i = start;

    while (i < lines.length) {
      var m = listRe.exec(lines[i]);
      if (!m) break;
      var indent = m[1].replace(/\t/g, '  ').length;
      if (indent < baseIndent) break;
      if (indent > baseIndent + 1) {
        var sub = parseList(lines, i);
        html = html.replace(/<\/li>$/, '') + sub.html + '</li>';
        i = sub.next;
        continue;
      }
      var text = inline(m[3]);
      i++;
      while (i < lines.length && lines[i].trim() && !listRe.test(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
        text += ' ' + inline(lines[i].trim());
        i++;
      }
      html += '<li>' + text + '</li>';
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  function parseTable(lines, start) {
    function cells(row) {
      var s = row.trim();
      if (s.charAt(0) === '|') s = s.slice(1);
      if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
      return s.split('|').map(function (c) { return c.trim(); });
    }
    var head = cells(lines[start]);
    var aligns = cells(lines[start + 1]).map(function (c) {
      var l = c.charAt(0) === ':';
      var r = c.charAt(c.length - 1) === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    var i = start + 2;
    var html = '<div class="table-wrap"><table><thead><tr>';
    head.forEach(function (c, k) {
      html += '<th' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c) + '</th>';
    });
    html += '</tr></thead><tbody>';
    while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
      var row = cells(lines[i]);
      html += '<tr>';
      for (var k = 0; k < Math.max(row.length, head.length); k++) {
        html += '<td' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(row[k] || '') + '</td>';
      }
      html += '</tr>';
      i++;
    }
    return { html: html + '</tbody></table></div>', next: i };
  }

  function render(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var out = [];
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var fm = fenceRe.exec(line);
      if (fm) {
        var ch = fm[1].charAt(0);
        var need = fm[1].length;
        var lang = fm[2] || '';
        var buf = [];
        i++;
        while (i < n) {
          var closeRe = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + need + ',}\\s*$');
          if (closeRe.test(lines[i])) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        var code = buf.join('\n');
        out.push('<div class="md-code"><div class="md-code-head"><span>' + esc(lang) + '</span>' +
          '<button class="md-code-copy" type="button"><svg class="ico" style="width:16px;height:16px"><use href="#i-copy"/></svg>复制</button></div>' +
          '<pre><code>' + highlight(code, lang) + '</code></pre></div>');
        continue;
      }

      var hm = headingRe.exec(line);
      if (hm) {
        var lv = hm[1].length;
        out.push('<h' + lv + '>' + inline(hm[2].trim()) + '</h' + lv + '>');
        i++;
        continue;
      }

      if (hrRe.test(line)) { out.push('<hr>'); i++; continue; }

      if (quoteRe.test(line)) {
        var q = [];
        while (i < n && quoteRe.test(lines[i])) {
          q.push(lines[i].replace(quoteRe, ''));
          i++;
        }
        out.push('<blockquote>' + render(q.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.indexOf('|') >= 0 && i + 1 < n && tableSepRe.test(lines[i + 1])) {
        var tb = parseTable(lines, i);
        out.push(tb.html);
        i = tb.next;
        continue;
      }

      if (listRe.test(line)) {
        var lb = parseList(lines, i);
        out.push(lb.html);
        i = lb.next;
        continue;
      }

      var para = [line];
      i++;
      while (i < n) {
        var next = lines[i];
        if (!next.trim()) break;
        if (fenceRe.test(next) || headingRe.test(next) || hrRe.test(next) || quoteRe.test(next) || listRe.test(next)) break;
        if (next.indexOf('|') >= 0 && i + 1 < n && tableSepRe.test(lines[i + 1])) break;
        para.push(next);
        i++;
      }
      out.push('<p>' + inline(para.join('\n')) + '</p>');
    }
    return out.join('');
  }

  global.MD = { render: render, esc: esc, inline: inline, highlight: highlight };
})(window);

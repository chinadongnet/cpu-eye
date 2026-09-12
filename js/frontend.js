/* ============================================================
 * CPU-EYE  前端：词法分析 + 语法分析（C++ 子集）
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});

  /* ---------------- 类型系统 ---------------- */
  var TY = {
    int:   function () { return { kind: 'int' }; },
    char:  function () { return { kind: 'char' }; },
    bool:  function () { return { kind: 'bool' }; },
    void:  function () { return { kind: 'void' }; },
    ptr:   function (b) { return { kind: 'ptr', base: b }; },
    array: function (b, n) { return { kind: 'array', base: b, len: n }; }
  };
  function sizeOf(t, W) {
    switch (t.kind) {
      case 'char': case 'bool': case 'void': return 1;
      case 'int':  return 4;
      case 'ptr':  return W;
      case 'array': return t.len * sizeOf(t.base, W);
    }
    return 4;
  }
  function alignOf(t, W) { return t.kind === 'array' ? alignOf(t.base, W) : sizeOf(t, W); }
  function isPtr(t) { return !!t && (t.kind === 'ptr' || t.kind === 'array'); }
  function typeName(t) {
    if (!t) return '?';
    if (t.kind === 'ptr') return typeName(t.base) + '*';
    if (t.kind === 'array') return typeName(t.base) + '[' + t.len + ']';
    return t.kind;
  }

  /* ---------------- 词法分析 ---------------- */
  var KEYWORDS = ['int','char','void','bool','long','short','unsigned','signed','const',
                  'return','if','else','while','for','break','continue','do','sizeof'];
  var PUNCT = ['<<=','>>=','::','<<','>>','++','--','==','!=','<=','>=','&&','||',
               '+=','-=','*=','/=','%=','&=','|=','^=','->',
               '(',')','{','}','[',']',';',',','=','+','-','*','/','%','<','>','!',
               '&','|','^','~','?',':','.'];

  function CompileError(msg, line) {
    var e = new Error(msg); e.line = line; e.isCompileError = true; return e;
  }

  function tokenize(src) {
    var toks = [], i = 0, line = 1, n = src.length;
    function isD(c) { return c >= '0' && c <= '9'; }
    function isA(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
    while (i < n) {
      var c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }        // 预处理指令整行忽略
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
        i += 2; continue;
      }
      if (c === '"') {
        i++; var s = '';
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\') {
            var e = src[i + 1];
            s += (e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '\0' : e === '\\' ? '\\' : e === '"' ? '"' : e);
            i += 2;
          } else { s += src[i++]; }
        }
        if (i >= n) throw CompileError('字符串常量未闭合', line);
        i++; toks.push({ kind: 'str', val: s, line: line }); continue;
      }
      if (c === "'") {
        i++; var ch;
        if (src[i] === '\\') {
          var e2 = src[i + 1];
          ch = (e2 === 'n' ? 10 : e2 === 't' ? 9 : e2 === '0' ? 0 : e2 === '\\' ? 92 : e2.charCodeAt(0));
          i += 2;
        } else { ch = src.charCodeAt(i); i++; }
        if (src[i] !== "'") throw CompileError('字符常量未闭合', line);
        i++; toks.push({ kind: 'num', val: ch, line: line }); continue;
      }
      if (isD(c)) {
        var st = i;
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          i += 2; while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
          toks.push({ kind: 'num', val: parseInt(src.slice(st, i), 16), line: line }); continue;
        }
        while (i < n && isD(src[i])) i++;
        while (i < n && /[uUlL]/.test(src[i])) i++;
        toks.push({ kind: 'num', val: parseInt(src.slice(st, i), 10), line: line }); continue;
      }
      if (isA(c)) {
        var st2 = i;
        while (i < n && (isA(src[i]) || isD(src[i]))) i++;
        var w = src.slice(st2, i);
        toks.push({ kind: KEYWORDS.indexOf(w) >= 0 ? 'kw' : 'ident', val: w, line: line });
        continue;
      }
      var hit = null;
      for (var k = 0; k < PUNCT.length; k++) {
        if (src.startsWith(PUNCT[k], i)) { hit = PUNCT[k]; break; }
      }
      if (!hit) throw CompileError('无法识别的字符 ' + c, line);
      toks.push({ kind: 'punct', val: hit, line: line }); i += hit.length;
    }
    toks.push({ kind: 'eof', val: '<结束>', line: line });
    return toks;
  }

  /* ---------------- 语法分析 ---------------- */
  var BUILTINS = { print_int: '__print_int', print_char: '__print_char', print_str: '__print_str', print_nl: '__print_nl' };

  function parse(toks) {
    var p = 0;
    var ast = { globals: [], funcs: [], strings: [] };
    var scopes = [new Map()];
    var fn = null;
    var strCount = 0;
    var coutDepth = 0;   // >0 时 << 属于输出流而不是移位运算符

    function cur() { return toks[p]; }
    function ln() { return toks[p].line; }
    function at(v) { var t = toks[p]; return t.kind !== 'eof' && t.val === v; }
    function atKw(v) { var t = toks[p]; return t.kind === 'kw' && t.val === v; }
    function eat(v) { if (at(v)) { p++; return true; } return false; }
    function expect(v) {
      if (!eat(v)) throw CompileError('语法错误：期望 ' + v + ' ，实际是 ' + cur().val, ln());
    }
    function ident() {
      if (cur().kind !== 'ident') throw CompileError('语法错误：期望标识符，实际是 ' + cur().val, ln());
      return toks[p++].val;
    }

    function pushScope() { scopes.push(new Map()); }
    function popScope() { scopes.pop(); }
    function findVar(name) {
      for (var i = scopes.length - 1; i >= 0; i--) { var v = scopes[i].get(name); if (v) return v; }
      return null;
    }
    function declare(name, type, isGlobal) {
      var v = { name: name, type: type, isGlobal: !!isGlobal, offset: 0 };
      scopes[scopes.length - 1].set(name, v);
      if (!isGlobal && fn) fn.locals.push(v);
      return v;
    }
    function addString(s) {
      var lab = '.LC' + (strCount++);
      ast.strings.push({ label: lab, text: s });
      return lab;
    }

    /* --- 节点构造（带类型推导） --- */
    function nNum(v, line) { return { k: 'num', val: v, type: TY.int(), line: line }; }
    function decay(t) { return t.kind === 'array' ? TY.ptr(t.base) : t; }
    function nBin(op, l, r, line) {
      if (op === '+') {
        if (isPtr(l.type) && !isPtr(r.type)) return { k: 'bin', op: '+', l: l, r: r, scale: l.type.base, type: decay(l.type), line: line };
        if (!isPtr(l.type) && isPtr(r.type)) return nBin('+', r, l, line);
      }
      if (op === '-') {
        if (isPtr(l.type) && !isPtr(r.type)) return { k: 'bin', op: '-', l: l, r: r, scale: l.type.base, type: decay(l.type), line: line };
        if (isPtr(l.type) && isPtr(r.type)) return { k: 'ptrdiff', l: l, r: r, elem: l.type.base, type: TY.int(), line: line };
      }
      return { k: 'bin', op: op, l: l, r: r, type: TY.int(), line: line };
    }
    function nAssign(l, r, line) { return { k: 'assign', l: l, r: r, type: l.type, line: line }; }
    function nDeref(a, line) {
      if (!isPtr(a.type)) throw CompileError('不能对非指针类型解引用', line);
      return { k: 'deref', a: a, type: a.type.base, line: line };
    }

    /* --- 类型说明符 --- */
    function isTypeStart() {
      var t = cur();
      return t.kind === 'kw' && ['int','char','void','bool','long','short','unsigned','signed','const'].indexOf(t.val) >= 0;
    }
    function declspec() {
      var base = null, seen = false;
      while (isTypeStart()) {
        var w = toks[p].val; p++;
        if (w === 'int') { base = TY.int(); seen = true; }
        else if (w === 'char') { base = TY.char(); seen = true; }
        else if (w === 'bool') { base = TY.bool(); seen = true; }
        else if (w === 'void') { base = TY.void(); seen = true; }
        else if (w === 'long' || w === 'short' || w === 'unsigned' || w === 'signed') { if (!seen) base = TY.int(); }
      }
      if (!base) throw CompileError('缺少类型说明符', ln());
      return base;
    }
    function pointerTo(base) { while (eat('*')) base = TY.ptr(base); return base; }

    /* --- 表达式 --- */
    function expr() { return assign(); }

    function assign() {
      var node = logor();
      var line = ln();
      if (at('=')) { p++; return nAssign(node, assign(), line); }
      var ops = ['+=','-=','*=','/=','%='];
      for (var i = 0; i < ops.length; i++) {
        if (at(ops[i])) { p++; var rhs = assign(); return nAssign(node, nBin(ops[i][0], node, rhs, line), line); }
      }
      return node;
    }
    function logor() {
      var node = logand();
      while (at('||')) { var line = ln(); p++; node = { k: 'logor', l: node, r: logand(), type: TY.int(), line: line }; }
      return node;
    }
    function logand() {
      var node = equality();
      while (at('&&')) { var line = ln(); p++; node = { k: 'logand', l: node, r: equality(), type: TY.int(), line: line }; }
      return node;
    }
    function equality() {
      var node = relational();
      for (;;) {
        var line = ln();
        if (at('==')) { p++; node = nBin('==', node, relational(), line); }
        else if (at('!=')) { p++; node = nBin('!=', node, relational(), line); }
        else return node;
      }
    }
    function relational() {
      var node = shift();
      for (;;) {
        var line = ln();
        if (at('<=')) { p++; node = nBin('<=', node, shift(), line); }
        else if (at('>=')) { p++; node = nBin('<=', shift(), node, line); }
        else if (at('<') ) { p++; node = nBin('<', node, shift(), line); }
        else if (at('>') ) { p++; node = nBin('<', shift(), node, line); }
        else return node;
      }
    }
    function shift() {
      var node = add();
      if (coutDepth) return node;
      for (;;) {
        var line = ln();
        if (at('<<')) { p++; node = nBin('<<', node, add(), line); }
        else if (at('>>')) { p++; node = nBin('>>', node, add(), line); }
        else return node;
      }
    }
    function add() {
      var node = mul();
      for (;;) {
        var line = ln();
        if (at('+')) { p++; node = nBin('+', node, mul(), line); }
        else if (at('-')) { p++; node = nBin('-', node, mul(), line); }
        else return node;
      }
    }
    function mul() {
      var node = unary();
      for (;;) {
        var line = ln();
        if (at('*')) { p++; node = nBin('*', node, unary(), line); }
        else if (at('/')) { p++; node = nBin('/', node, unary(), line); }
        else if (at('%')) { p++; node = nBin('%', node, unary(), line); }
        else if (at('&')) { p++; node = nBin('&', node, unary(), line); }
        else if (at('|')) { p++; node = nBin('|', node, unary(), line); }
        else if (at('^')) { p++; node = nBin('^', node, unary(), line); }
        else return node;
      }
    }
    function unary() {
      var line = ln();
      if (at('+')) { p++; return unary(); }
      if (at('-')) { p++; return { k: 'neg', a: unary(), type: TY.int(), line: line }; }
      if (at('!')) { p++; return { k: 'not', a: unary(), type: TY.int(), line: line }; }
      if (at('~')) { p++; return { k: 'bnot', a: unary(), type: TY.int(), line: line }; }
      if (at('*')) { p++; return nDeref(unary(), line); }
      if (at('&')) { p++; var a = unary(); return { k: 'addr', a: a, type: TY.ptr(a.type), line: line }; }
      if (at('++')) { p++; var t1 = unary(); return nAssign(t1, nBin('+', t1, nNum(1, line), line), line); }
      if (at('--')) { p++; var t2 = unary(); return nAssign(t2, nBin('-', t2, nNum(1, line), line), line); }
      return postfix();
    }
    function postfix() {
      var node = primary();
      for (;;) {
        var line = ln();
        if (at('[')) {
          p++; var sv2 = coutDepth; coutDepth = 0;
          var idx = expr(); coutDepth = sv2; expect(']');
          node = nDeref(nBin('+', node, idx, line), line); continue;
        }
        if (at('++')) { p++; node = nBin('-', nAssign(node, nBin('+', node, nNum(1, line), line), line), nNum(1, line), line); continue; }
        if (at('--')) { p++; node = nBin('+', nAssign(node, nBin('-', node, nNum(1, line), line), line), nNum(1, line), line); continue; }
        return node;
      }
    }
    function funcArgs() {
      var args = [];
      var sv = coutDepth; coutDepth = 0;
      expect('(');
      if (!at(')')) { do { args.push(assign()); } while (eat(',')); }
      expect(')');
      coutDepth = sv;
      return args;
    }
    function primary() {
      var line = ln(), t = cur();
      if (at('(')) { p++; var sv = coutDepth; coutDepth = 0; var node = expr(); coutDepth = sv; expect(')'); return node; }
      if (t.kind === 'num') { p++; return nNum(t.val, line); }
      if (t.kind === 'str') { p++; return { k: 'strlit', label: addString(t.val), type: TY.ptr(TY.char()), line: line }; }
      if (atKw('sizeof')) { p++; expect('('); var ty = declspec(); ty = pointerTo(ty); expect(')'); return { k: 'sizeof', ty: ty, type: TY.int(), line: line }; }
      if (t.kind === 'ident') {
        var name = t.val; p++;
        if (at('(')) {
          var args = funcArgs();
          return { k: 'call', name: BUILTINS[name] || name, args: args, type: TY.int(), line: line };
        }
        var v = findVar(name);
        if (!v) throw CompileError('未声明的标识符 ' + name, line);
        return { k: 'var', v: v, type: v.type, line: line };
      }
      throw CompileError('语法错误：无法解析的记号 ' + t.val, line);
    }

    /* --- 语句 --- */
    function isCoutStart() {
      if (at('cout')) return 1;
      if (at('std') && toks[p + 1] && toks[p + 1].val === '::' && toks[p + 2] && toks[p + 2].val === 'cout') return 3;
      return 0;
    }
    function coutStmt() {
      var line = ln();
      p += isCoutStart();
      var body = [];
      coutDepth++;
      while (at('<<')) {
        p++;
        var l2 = ln();
        if (at('endl') || (at('std') && toks[p + 1] && toks[p + 1].val === '::' && toks[p + 2] && toks[p + 2].val === 'endl')) {
          p += at('endl') ? 1 : 3;
          body.push({ k: 'expr', e: { k: 'call', name: '__print_nl', args: [], type: TY.int(), line: l2 }, line: l2 });
          continue;
        }
        var e = assign();
        var callee = (e.k === 'strlit') ? '__print_str'
                   : (e.type && e.type.kind === 'char') ? '__print_char' : '__print_int';
        body.push({ k: 'expr', e: { k: 'call', name: callee, args: [e], type: TY.int(), line: l2 }, line: l2 });
      }
      coutDepth--;
      expect(';');
      return { k: 'block', body: body, line: line };
    }

    function declStmt() {
      var line = ln();
      var base = declspec();
      var body = [];
      var first = true;
      while (!at(';')) {
        if (!first) expect(',');
        first = false;
        var ty = pointerTo(base);
        var name = ident();
        if (at('[')) {
          p++;
          var lenTok = cur();
          if (lenTok.kind !== 'num') throw CompileError('数组长度必须是整型常量', ln());
          p++; expect(']');
          ty = TY.array(ty, lenTok.val);
        }
        var v = declare(name, ty, false);
        if (at('=')) {
          p++;
          if (at('{')) {
            p++;
            var i = 0;
            if (!at('}')) {
              do {
                var ev = assign();
                var target = nDeref(nBin('+', { k: 'var', v: v, type: v.type, line: line }, nNum(i, line), line), line);
                body.push({ k: 'expr', e: nAssign(target, ev, line), line: line });
                i++;
              } while (eat(','));
            }
            expect('}');
          } else {
            body.push({ k: 'expr', e: nAssign({ k: 'var', v: v, type: v.type, line: line }, assign(), line), line: line });
          }
        }
      }
      p++; // ';'
      return { k: 'block', body: body, line: line };
    }

    function stmt() {
      var line = ln();
      if (at('{')) return block();
      if (at(';')) { p++; return { k: 'block', body: [], line: line }; }
      if (atKw('return')) {
        p++;
        if (at(';')) { p++; return { k: 'ret', e: null, line: line }; }
        var e = expr(); expect(';');
        return { k: 'ret', e: e, line: line };
      }
      if (atKw('if')) {
        p++; expect('(');
        var c = expr(); expect(')');
        var th = stmt(), el = null;
        if (atKw('else')) { p++; el = stmt(); }
        return { k: 'if', c: c, th: th, el: el, line: line };
      }
      if (atKw('while')) {
        p++; expect('(');
        var wc = expr(); expect(')');
        return { k: 'while', c: wc, body: stmt(), line: line };
      }
      if (atKw('do')) {
        p++;
        var db = stmt();
        if (!atKw('while')) throw CompileError('期望 while', ln());
        p++; expect('('); var dc = expr(); expect(')'); expect(';');
        return { k: 'dowhile', c: dc, body: db, line: line };
      }
      if (atKw('for')) {
        p++; expect('(');
        pushScope();
        var init = null;
        if (at(';')) p++;
        else if (isTypeStart()) init = declStmt();
        else { var ie = expr(); expect(';'); init = { k: 'expr', e: ie, line: line }; }
        var cond = at(';') ? null : expr(); expect(';');
        var step = at(')') ? null : expr(); expect(')');
        var body = stmt();
        popScope();
        return { k: 'for', init: init, c: cond, step: step, body: body, line: line };
      }
      if (atKw('break')) { p++; expect(';'); return { k: 'break', line: line }; }
      if (atKw('continue')) { p++; expect(';'); return { k: 'continue', line: line }; }
      if (isTypeStart()) return declStmt();
      if (isCoutStart()) return coutStmt();
      var ex = expr(); expect(';');
      return { k: 'expr', e: ex, line: line };
    }

    function block() {
      var line = ln();
      expect('{');
      pushScope();
      var body = [];
      while (!at('}')) {
        if (cur().kind === 'eof') throw CompileError('缺少右大括号', ln());
        body.push(stmt());
      }
      p++;
      popScope();
      return { k: 'block', body: body, line: line };
    }

    /* --- 顶层 --- */
    function constExpr() {
      var neg = false;
      while (at('-') || at('+')) { if (at('-')) neg = !neg; p++; }
      if (cur().kind !== 'num') throw CompileError('全局初始化只支持整型常量', ln());
      var v = toks[p++].val;
      return neg ? -v : v;
    }
    function globalVar(base) {
      do {
        var ty = pointerTo(base);
        var name = ident();
        if (at('[')) {
          p++;
          var lt = cur();
          if (lt.kind !== 'num') throw CompileError('数组长度必须是整型常量', ln());
          p++; expect(']');
          ty = TY.array(ty, lt.val);
        }
        var init = [];
        if (at('=')) {
          p++;
          if (at('{')) { p++; if (!at('}')) { do { init.push(constExpr()); } while (eat(',')); } expect('}'); }
          else init.push(constExpr());
        }
        var v = declare(name, ty, true);
        ast.globals.push({ name: name, type: ty, init: init, v: v });
      } while (eat(','));
      expect(';');
    }

    while (cur().kind !== 'eof') {
      if (at('using') || at('namespace')) { while (!at(';') && cur().kind !== 'eof') p++; eat(';'); continue; }
      if (at(';')) { p++; continue; }
      var base = declspec();
      var save = p;
      var ty0 = pointerTo(base);
      var nameTok = cur();
      if (nameTok.kind !== 'ident') throw CompileError('顶层声明缺少名字', ln());
      var name = ident();
      if (at('(')) {
        p++;
        fn = { name: name, retType: ty0, params: [], locals: [], body: null, line: nameTok.line };
        pushScope();
        if (!at(')')) {
          if (atKw('void') && toks[p + 1] && toks[p + 1].val === ')') { p++; }
          else {
            do {
              var pb = declspec();
              var pt = pointerTo(pb);
              var pn = ident();
              if (at('[')) { p++; if (cur().kind === 'num') p++; expect(']'); pt = TY.ptr(pt); }
              fn.params.push(declare(pn, pt, false));
            } while (eat(','));
          }
        }
        expect(')');
        if (at(';')) { p++; popScope(); fn = null; continue; }
        fn.body = block();
        popScope();
        ast.funcs.push(fn);
        fn = null;
      } else {
        p = save;
        globalVar(base);
      }
    }
    var hasMain = false;
    for (var fi = 0; fi < ast.funcs.length; fi++) if (ast.funcs[fi].name === 'main') hasMain = true;
    if (!hasMain) throw CompileError('程序缺少 main 函数', 1);
    return ast;
  }

  CE.TY = TY; CE.sizeOf = sizeOf; CE.alignOf = alignOf; CE.isPtr = isPtr; CE.typeName = typeName;
  CE.tokenize = tokenize; CE.parse = parse; CE.CompileError = CompileError;
})(typeof window !== 'undefined' ? window : globalThis);

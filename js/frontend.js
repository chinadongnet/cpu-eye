/* ============================================================
 * CPU-EYE  前端：词法分析 + 语法分析（C++ 子集）
 * 支持：基本类型 / 指针 / 引用 / 数组 / 函数 / 递归
 *       class 与 struct：数据成员、成员函数、构造函数、this
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
    ref:   function (b) { return { kind: 'ref', base: b }; },
    array: function (b, n) { return { kind: 'array', base: b, len: n }; },
    struct: function (name, isClass) {
      return { kind: 'struct', name: name, isClass: !!isClass, members: [], methods: {},
               ctor: null, complete: false, size: 0, align: 1, _lw: 0 };
    }
  };
  function alignTo(n, a) { return Math.floor((n + a - 1) / a) * a; }

  // 结构体/类的内存布局与目标机字长有关（指针成员 4 或 8 字节），按需计算并缓存
  function layoutStruct(t, W) {
    if (t._lw === W) return;
    t._lw = W;
    var off = 0, maxAlign = 1;
    for (var i = 0; i < t.members.length; i++) {
      var m = t.members[i];
      var a = alignOf(m.type, W), s = sizeOf(m.type, W);
      off = alignTo(off, a);
      m.offset = off;
      off += s;
      if (a > maxAlign) maxAlign = a;
    }
    t.align = maxAlign;
    t.size = Math.max(alignTo(off, maxAlign), 1);
  }
  function sizeOf(t, W) {
    switch (t.kind) {
      case 'char': case 'bool': case 'void': return 1;
      case 'int': return 4;
      case 'ptr': case 'ref': return W;
      case 'array': return t.len * sizeOf(t.base, W);
      case 'struct': layoutStruct(t, W); return t.size;
    }
    return 4;
  }
  function alignOf(t, W) {
    if (t.kind === 'array') return alignOf(t.base, W);
    if (t.kind === 'struct') { layoutStruct(t, W); return t.align; }
    return sizeOf(t, W);
  }
  function isPtr(t) { return !!t && (t.kind === 'ptr' || t.kind === 'array'); }
  function isAggregate(t) { return !!t && (t.kind === 'array' || t.kind === 'struct'); }
  function typeName(t) {
    if (!t) return '?';
    if (t.kind === 'ptr') return typeName(t.base) + '*';
    if (t.kind === 'ref') return typeName(t.base) + '&';
    if (t.kind === 'array') return typeName(t.base) + '[' + t.len + ']';
    if (t.kind === 'struct') return t.name;
    return t.kind;
  }

  /* ---------------- 词法分析 ---------------- */
  var BASIC = ['int', 'char', 'void', 'bool', 'long', 'short', 'unsigned', 'signed'];
  var KEYWORDS = BASIC.concat([
    'const', 'return', 'if', 'else', 'while', 'for', 'break', 'continue', 'do', 'sizeof',
    'struct', 'class', 'public', 'private', 'protected', 'this',
    'true', 'false', 'nullptr', 'NULL',
    'new', 'delete', 'template', 'virtual', 'typedef', 'enum', 'union',
    'static', 'auto', 'operator', 'friend', 'typename', 'inline',
    'try', 'catch', 'throw'
  ]);
  var UNSUPPORTED = {
    'new': '动态内存分配 new', 'delete': 'delete', 'template': '模板 template',
    'virtual': '虚函数 virtual', 'typedef': 'typedef', 'enum': 'enum', 'union': 'union',
    'static': 'static 存储类', 'auto': 'auto 类型推导', 'operator': '运算符重载 operator',
    'friend': 'friend', 'typename': 'typename', 'try': 'try/catch 异常',
    'catch': 'try/catch 异常', 'throw': 'throw 异常'
  };
  var STDLIB = {
    vector: 'std::vector', string: 'std::string', map: 'std::map', set: 'std::set',
    list: 'std::list', queue: 'std::queue', stack: 'std::stack', pair: 'std::pair',
    cin: 'std::cin（标准输入）', printf: 'printf', scanf: 'scanf',
    malloc: 'malloc', free: 'free', memcpy: 'memcpy', strlen: 'strlen'
  };
  var PUNCT = ['<<=', '>>=', '::', '<<', '>>', '++', '--', '==', '!=', '<=', '>=', '&&', '||',
               '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->',
               '(', ')', '{', '}', '[', ']', ';', ',', '=', '+', '-', '*', '/', '%', '<', '>', '!',
               '&', '|', '^', '~', '?', ':', '.'];

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
    var ast = { globals: [], funcs: [], strings: [], structs: [] };
    var scopes = [new Map()];
    var structs = new Map();
    var fn = null;
    var curClass = null;
    var strCount = 0, anonCount = 0;
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
    function checkUnsupported() {
      var t = cur();
      if (t.kind === 'kw' && UNSUPPORTED[t.val])
        throw CompileError('暂不支持 ' + UNSUPPORTED[t.val] + '（本模拟器实现的是 C++ 常用子集，详见“使用说明”）', t.line);
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
    function findMember(cls, name) {
      for (var i = 0; i < cls.members.length; i++) if (cls.members[i].name === name) return cls.members[i];
      return null;
    }

    /* --- 节点构造（带类型推导） --- */
    function nNum(v, line) { return { k: 'num', val: v, type: TY.int(), line: line }; }
    function decay(t) { return t.kind === 'array' ? TY.ptr(t.base) : t; }
    function varNode(v, line) {
      // 引用变量：槽里存的是目标地址，表达式类型直接是被引用的类型
      if (v.type.kind === 'ref') return { k: 'refvar', v: v, type: v.type.base, line: line };
      return { k: 'var', v: v, type: v.type, line: line };
    }
    function nBin(op, l, r, line) {
      if (op === '+') {
        if (isPtr(l.type) && !isPtr(r.type)) return { k: 'bin', op: '+', l: l, r: r, scale: l.type.base, type: decay(l.type), line: line };
        if (!isPtr(l.type) && isPtr(r.type)) return nBin('+', r, l, line);
      }
      if (op === '-') {
        if (isPtr(l.type) && !isPtr(r.type)) return { k: 'bin', op: '-', l: l, r: r, scale: l.type.base, type: decay(l.type), line: line };
        if (isPtr(l.type) && isPtr(r.type)) return { k: 'ptrdiff', l: l, r: r, elem: l.type.base, type: TY.int(), line: line };
      }
      if (l.type && l.type.kind === 'struct') throw CompileError('对象不能直接参与 ' + op + ' 运算（没有运算符重载）', line);
      return { k: 'bin', op: op, l: l, r: r, type: TY.int(), line: line };
    }
    function nAssign(l, r, line) {
      if (l.type && l.type.kind === 'struct' && (!r.type || r.type.kind !== 'struct'))
        throw CompileError('不能把非对象赋给对象 ' + typeName(l.type), line);
      return { k: 'assign', l: l, r: r, type: l.type, line: line };
    }
    function nDeref(a, line) {
      if (!isPtr(a.type)) throw CompileError('不能对 ' + typeName(a.type) + ' 类型解引用', line);
      return { k: 'deref', a: a, type: a.type.base, line: line };
    }
    function makeMember(obj, mname, viaPtr, line) {
      var cls = viaPtr ? (isPtr(obj.type) ? obj.type.base : null) : obj.type;
      if (!cls || cls.kind !== 'struct')
        throw CompileError((viaPtr ? '-> ' : '. ') + '左边不是' + (viaPtr ? '指向对象的指针' : '对象') +
                           '（实际类型 ' + typeName(obj.type) + '）', line);
      if (at('(')) {                                    // 成员函数调用
        var m = cls.methods[mname];
        if (!m) throw CompileError('类 ' + cls.name + ' 没有成员函数 ' + mname + '()', line);
        var args = funcArgs();
        if (args.length !== m.arity)
          throw CompileError(cls.name + '::' + mname + '() 需要 ' + m.arity + ' 个参数，实际给了 ' + args.length + ' 个', line);
        args.unshift(viaPtr ? obj : { k: 'addr', a: obj, type: TY.ptr(cls), line: line });
        return { k: 'call', name: m.name, args: args, type: m.ret, line: line };
      }
      var mem = findMember(cls, mname);
      if (!mem) {
        if (cls.methods[mname]) throw CompileError('成员函数 ' + mname + ' 调用时要加括号：' + mname + '()', line);
        throw CompileError('类 ' + cls.name + ' 没有成员 ' + mname, line);
      }
      return { k: 'member', obj: obj, viaPtr: !!viaPtr, m: mem, cls: cls, type: mem.type, line: line };
    }

    /* --- 类型说明符 --- */
    function isBasicKw(t) { return t.kind === 'kw' && BASIC.indexOf(t.val) >= 0; }
    function isTypeStart() {
      var t = cur();
      if (t.kind === 'kw') return BASIC.indexOf(t.val) >= 0 || t.val === 'struct' || t.val === 'class' || t.val === 'const';
      if (t.kind === 'ident' && structs.has(t.val)) {
        var nx = toks[p + 1];
        return !!nx && (nx.kind === 'ident' || nx.val === '*' || nx.val === '&' || nx.val === '::');
      }
      return false;
    }
    function declspec() {
      var base = null, seen = false;
      for (;;) {
        var t = cur();
        if (t.kind === 'kw' && (t.val === 'const' || t.val === 'inline')) { p++; continue; }
        if (t.kind === 'kw' && (t.val === 'struct' || t.val === 'class')) { base = structSpec(); seen = true; continue; }
        if (isBasicKw(t)) {
          p++;
          if (t.val === 'int') { base = TY.int(); seen = true; }
          else if (t.val === 'char') { base = TY.char(); seen = true; }
          else if (t.val === 'bool') { base = TY.bool(); seen = true; }
          else if (t.val === 'void') { base = TY.void(); seen = true; }
          else if (!seen) { base = TY.int(); }              // long / short / unsigned / signed
          continue;
        }
        if (!seen && t.kind === 'ident' && structs.has(t.val)) {
          // 允许不完整类型：Node* next; 这样的自引用指针是合法的，
          // 真正需要完整类型的地方（按值声明变量、成员）再单独检查
          base = structs.get(t.val); seen = true; p++; continue;
        }
        break;
      }
      if (!base) throw CompileError('缺少类型说明符', ln());
      return base;
    }
    // 按值使用一个类型时，它必须已经定义完整（指针/引用则不需要）
    function requireComplete(ty, line) {
      var b = ty;
      while (b.kind === 'array') b = b.base;
      if (b.kind === 'struct' && !b.complete)
        throw CompileError('类 ' + b.name + ' 只有声明还没有定义，不能用它定义对象', line);
    }
    function pointerTo(base) {
      for (;;) {
        if (at('*')) { p++; base = TY.ptr(base); continue; }
        if (at('&&')) throw CompileError('暂不支持右值引用 &&', ln());
        if (at('&')) { p++; base = TY.ref(base); continue; }
        break;
      }
      return base;
    }

    /* --- 类 / 结构体 --- */
    function skipBalanced(open, close) {
      var d = 0;
      do {
        if (at(open)) d++;
        else if (at(close)) d--;
        p++;
        if (cur().kind === 'eof' && d > 0) throw CompileError('括号不匹配', ln());
      } while (d > 0);
    }
    function countParams(i) {
      var d = 0, n = 0, seen = false;
      for (var k = i; k < toks.length; k++) {
        var v = toks[k].val;
        if (v === '(') { d++; continue; }
        if (v === ')') { d--; if (d === 0) break; continue; }
        if (d === 1) { if (v === ',') n++; else if (v !== 'void') seen = true; }
      }
      return seen ? n + 1 : 0;
    }
    function skipMethodTail() {
      if (at('const')) p++;
      if (at(':')) throw CompileError('暂不支持构造函数初始化列表，请在函数体里给成员赋值', ln());
      if (at(';')) { p++; return; }
      if (!at('{')) throw CompileError('成员函数缺少函数体', ln());
      skipBalanced('{', '}');
    }

    function structSpec() {
      var kw = toks[p].val; p++;                            // struct | class
      var name = (cur().kind === 'ident') ? toks[p++].val : ('$匿名' + (anonCount++));
      var ty = structs.get(name);
      if (!ty) { ty = TY.struct(name, kw === 'class'); structs.set(name, ty); ast.structs.push(ty); }
      if (at(':')) throw CompileError('暂不支持继承（没有虚函数表与基类布局）', ln());
      if (!at('{')) return ty;                              // 前向声明或引用已有类型
      if (ty.complete) throw CompileError('类 ' + name + ' 重复定义', ln());
      parseClassBody(ty);
      return ty;
    }

    function parseClassBody(ty) {
      expect('{');
      var pending = [];
      while (!at('}')) {
        if (cur().kind === 'eof') throw CompileError('类 ' + ty.name + ' 的定义缺少右大括号', ln());
        if (at('public') || at('private') || at('protected')) { p++; expect(':'); continue; }
        if (at(';')) { p++; continue; }
        if (at('~')) throw CompileError('暂不支持析构函数 ~' + ty.name + '()', ln());
        checkUnsupported();
        // 构造函数
        if (cur().kind === 'ident' && cur().val === ty.name && toks[p + 1] && toks[p + 1].val === '(') {
          if (ty.ctor) throw CompileError('暂不支持重载构造函数，' + ty.name + ' 只能有一个构造函数', ln());
          p++;
          ty.ctor = { name: ty.name + '::' + ty.name, arity: countParams(p), defined: false };
          pending.push({ name: ty.ctor.name, ret: TY.void(), idx: p, ctor: ty.ctor });
          skipBalanced('(', ')');
          skipMethodTail();
          continue;
        }
        var base = declspec();
        for (;;) {
          var mt = pointerTo(base);
          var mname = ident();
          if (at('(')) {                                     // 成员函数
            if (ty.methods[mname]) throw CompileError('暂不支持重载成员函数 ' + mname + '()', ln());
            ty.methods[mname] = { name: ty.name + '::' + mname, ret: mt, arity: countParams(p), defined: false };
            pending.push({ name: ty.methods[mname].name, ret: mt, idx: p, m: ty.methods[mname] });
            skipBalanced('(', ')');
            skipMethodTail();
            break;
          }
          if (at('[')) {
            p++;
            var lt = cur();
            if (lt.kind !== 'num') throw CompileError('数组长度必须是整型常量', ln());
            p++; expect(']');
            mt = TY.array(mt, lt.val);
          }
          if (mt === ty) throw CompileError('类不能包含自身类型的成员（可以用指针 ' + ty.name + '*）', ln());
          if (mt.kind === 'struct' && !mt.complete) throw CompileError('成员类型 ' + mt.name + ' 还没有定义完整', ln());
          if (mt.kind === 'ref') throw CompileError('暂不支持引用类型的成员', ln());
          if (findMember(ty, mname)) throw CompileError('成员 ' + mname + ' 重复定义', ln());
          ty.members.push({ name: mname, type: mt, offset: 0 });
          if (at(',')) { p++; continue; }
          expect(';');
          break;
        }
      }
      expect('}');
      ty.complete = true;
      // 第二遍：类体完整后再解析方法体（这样方法里可以引用后面才声明的成员）
      var save = p;
      for (var i = 0; i < pending.length; i++) {
        p = pending[i].idx;
        var f = parseFunction(pending[i].name, pending[i].ret, ty);
        if (f) { if (pending[i].ctor) pending[i].ctor.defined = true; if (pending[i].m) pending[i].m.defined = true; }
      }
      p = save;
    }

    /* --- 函数 / 成员函数 --- */
    function parseFunction(name, retType, clsType) {
      var outerFn = fn, outerClass = curClass;
      fn = { name: name, retType: retType, params: [], locals: [], body: null,
             line: toks[p].line, cls: clsType || null, isMethod: !!clsType };
      pushScope();
      if (clsType) fn.params.push(declare('this', TY.ptr(clsType), false));
      expect('(');
      if (!at(')')) {
        if (atKw('void') && toks[p + 1] && toks[p + 1].val === ')') { p++; }
        else {
          do {
            var pb = declspec();
            var pt = pointerTo(pb);
            var pn = (cur().kind === 'ident') ? ident() : ('__arg' + fn.params.length);
            if (at('[')) { p++; if (cur().kind === 'num') p++; expect(']'); pt = TY.ptr(pt); }
            if (pt.kind === 'struct')
              throw CompileError('暂不支持按值传递对象，请改用指针 ' + pt.name + '* 或引用 ' + pt.name + '&', ln());
            fn.params.push(declare(pn, pt, false));
          } while (eat(','));
        }
      }
      expect(')');
      if (at('const')) p++;
      if (at(':')) throw CompileError('暂不支持构造函数初始化列表，请在函数体里给成员赋值', ln());
      if (at(';')) {                                  // 只是声明，不是定义
        p++; popScope(); fn = outerFn; curClass = outerClass; return null;
      }
      if (retType.kind === 'struct')
        throw CompileError('暂不支持返回对象，请改用指针或引用', fn.line);
      curClass = clsType || null;
      fn.body = block();
      popScope();
      var done = fn;
      fn = outerFn; curClass = outerClass;
      ast.funcs.push(done);
      return done;
    }

    /* --- 表达式 --- */
    function expr() { return assign(); }

    function assign() {
      var node = logor();
      var line = ln();
      if (at('=')) { p++; return nAssign(node, assign(), line); }
      var ops = ['+=', '-=', '*=', '/=', '%='];
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
        else if (at('<')) { p++; node = nBin('<', node, shift(), line); }
        else if (at('>')) { p++; node = nBin('<', shift(), node, line); }
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
          p++; var sv = coutDepth; coutDepth = 0;
          var idx = expr(); coutDepth = sv; expect(']');
          node = nDeref(nBin('+', node, idx, line), line); continue;
        }
        if (at('.')) { p++; node = makeMember(node, ident(), false, line); continue; }
        if (at('->')) { p++; node = makeMember(node, ident(), true, line); continue; }
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
      checkUnsupported();
      if (at('(')) {
        // 类型转换 (T)expr
        var mark = p;
        p++;
        if (isTypeStart()) {
          var cty = pointerTo(declspec());
          if (at(')')) {
            p++;
            if (cty.kind === 'struct') throw CompileError('不能转换成对象类型 ' + cty.name, line);
            if (cty.kind === 'ref') throw CompileError('不支持转换成引用类型', line);
            return { k: 'cast', ty: cty, a: unary(), type: cty, line: line };
          }
        }
        p = mark;
        p++;
        var sv = coutDepth; coutDepth = 0;
        var node = expr();
        coutDepth = sv; expect(')');
        return node;
      }
      if (t.kind === 'num') { p++; return nNum(t.val, line); }
      if (t.kind === 'str') { p++; return { k: 'strlit', label: addString(t.val), type: TY.ptr(TY.char()), line: line }; }
      if (atKw('true')) { p++; return nNum(1, line); }
      if (atKw('false')) { p++; return nNum(0, line); }
      if (atKw('nullptr') || atKw('NULL')) { p++; return { k: 'num', val: 0, type: TY.ptr(TY.void()), line: line }; }
      if (atKw('this')) {
        p++;
        var tv = findVar('this');
        if (!tv) throw CompileError('this 只能在成员函数里使用', line);
        return varNode(tv, line);
      }
      if (atKw('sizeof')) {
        p++; expect('(');
        var ty;
        if (cur().kind === 'ident' && structs.has(cur().val)) { ty = structs.get(cur().val); p++; }
        else ty = declspec();
        ty = pointerTo(ty);
        expect(')');
        if (ty.kind === 'struct') requireComplete(ty, line);
        return { k: 'sizeof', ty: ty, type: TY.int(), line: line };
      }
      if (t.kind === 'ident') {
        var name = t.val; p++;
        if (at('::')) throw CompileError('暂不支持限定名 ' + name + '::（命名空间与静态成员）', line);
        if (at('(')) {
          if (curClass && curClass.methods[name]) {           // 成员函数内部的未限定调用
            var m = curClass.methods[name];
            var margs = funcArgs();
            margs.unshift(varNode(findVar('this'), line));
            return { k: 'call', name: m.name, args: margs, type: m.ret, line: line };
          }
          var args = funcArgs();
          return { k: 'call', name: BUILTINS[name] || name, args: args, type: TY.int(), line: line };
        }
        var v = findVar(name);
        if (v) return varNode(v, line);
        if (curClass) {                                       // 成员函数内部直接写成员名
          var mem = findMember(curClass, name);
          if (mem) {
            return { k: 'member', obj: varNode(findVar('this'), line), viaPtr: true,
                     m: mem, cls: curClass, type: mem.type, line: line };
          }
        }
        if (structs.has(name)) throw CompileError(name + ' 是一个类名，不能直接当作值使用', line);
        if (STDLIB[name])
          throw CompileError('暂不支持 ' + STDLIB[name] + '（本模拟器没有标准库，可以用数组、指针和 cout 代替）', line);
        throw CompileError('未声明的标识符 ' + name, line);
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
        if (e.type && e.type.kind === 'struct')
          throw CompileError('不能直接输出对象（没有运算符重载），请输出它的成员', l2);
        var callee = (e.k === 'strlit') ? '__print_str'
                   : (e.type && e.type.kind === 'char') ? '__print_char' : '__print_int';
        body.push({ k: 'expr', e: { k: 'call', name: callee, args: [e], type: TY.int(), line: l2 }, line: l2 });
      }
      coutDepth--;
      expect(';');
      return { k: 'block', body: body, line: line };
    }

    function exprStmt(e, line) { return { k: 'expr', e: e, line: line }; }

    function declStmt() {
      var line = ln();
      var base = declspec();
      var body = [];
      if (at(';')) { p++; return { k: 'block', body: body, line: line }; }   // 仅类型定义
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
        if (ty.kind === 'ref' && !at('=')) throw CompileError('引用 ' + name + ' 必须初始化', ln());
        requireComplete(ty, line);
        var v = declare(name, ty, false);
        var vn = varNode(v, line);

        if (at('(')) {                                    // A a(1, 2);  调用构造函数
          var cls = ty.kind === 'struct' ? ty : null;
          if (!cls || !cls.ctor) throw CompileError('只有带构造函数的类才能用 ' + name + '(...) 形式初始化', ln());
          var cargs = funcArgs();
          if (cargs.length !== cls.ctor.arity)
            throw CompileError(cls.name + ' 的构造函数需要 ' + cls.ctor.arity + ' 个参数，实际给了 ' + cargs.length + ' 个', line);
          cargs.unshift({ k: 'addr', a: vn, type: TY.ptr(cls), line: line });
          body.push(exprStmt({ k: 'call', name: cls.ctor.name, args: cargs, type: TY.void(), line: line }, line));
          continue;
        }
        if (at('=')) {
          p++;
          if (at('{')) {                                  // 初始化列表
            p++;
            var i = 0;
            if (!at('}')) {
              do {
                var ev = assign();
                var target;
                if (ty.kind === 'struct') {
                  if (i >= ty.members.length) throw CompileError('初始化列表比 ' + ty.name + ' 的成员还多', ln());
                  target = { k: 'member', obj: vn, viaPtr: false, m: ty.members[i], cls: ty, type: ty.members[i].type, line: line };
                } else {
                  target = nDeref(nBin('+', vn, nNum(i, line), line), line);
                }
                body.push(exprStmt(nAssign(target, ev, line), line));
                i++;
              } while (eat(','));
            }
            expect('}');
          } else if (ty.kind === 'ref') {                 // int& r = x;  绑定到左值
            var initE = assign();
            body.push(exprStmt({ k: 'bindref', v: v, a: initE, type: ty, line: line }, line));
          } else {
            body.push(exprStmt(nAssign(vn, assign(), line), line));
          }
          continue;
        }
        // 无初始化：有默认构造函数就调用
        if (ty.kind === 'struct' && ty.ctor) {
          if (ty.ctor.arity !== 0)
            throw CompileError(ty.name + ' 的构造函数需要 ' + ty.ctor.arity + ' 个参数，请写成 ' + name + '(...)', line);
          body.push(exprStmt({ k: 'call', name: ty.ctor.name,
                               args: [{ k: 'addr', a: vn, type: TY.ptr(ty), line: line }],
                               type: TY.void(), line: line }, line));
        }
      }
      p++; // ';'
      return { k: 'block', body: body, line: line };
    }

    function stmt() {
      var line = ln();
      checkUnsupported();
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
        if (ty.kind === 'ref') throw CompileError('暂不支持全局引用', ln());
        requireComplete(ty, ln());
        if (ty.kind === 'struct' && ty.ctor)
          throw CompileError('全局对象暂不支持构造函数（没有静态初始化阶段），请把 ' + name + ' 放进函数里', ln());
        var init = [];
        if (at('=')) {
          p++;
          if (at('{')) { p++; if (!at('}')) { do { init.push(constExpr()); } while (eat(',')); } expect('}'); }
          else init.push(constExpr());
        }
        declare(name, ty, true);
        ast.globals.push({ name: name, type: ty, init: init });
      } while (eat(','));
      expect(';');
    }

    while (cur().kind !== 'eof') {
      if (at('using') || at('namespace')) { while (!at(';') && cur().kind !== 'eof') p++; eat(';'); continue; }
      if (at(';')) { p++; continue; }
      checkUnsupported();
      // 类外定义的构造函数：A::A(...) { }
      if (cur().kind === 'ident' && structs.has(cur().val) &&
          toks[p + 1] && toks[p + 1].val === '::' &&
          toks[p + 2] && toks[p + 2].val === cur().val) {
        var cls0 = structs.get(cur().val);
        p += 3;
        if (!cls0.ctor) cls0.ctor = { name: cls0.name + '::' + cls0.name, arity: countParams(p), defined: false };
        if (parseFunction(cls0.ctor.name, TY.void(), cls0)) cls0.ctor.defined = true;
        continue;
      }
      var base = declspec();
      if (at(';')) { p++; continue; }                      // struct A { ... };
      var save = p;
      var ty0 = pointerTo(base);
      if (cur().kind !== 'ident') throw CompileError('顶层声明缺少名字', ln());
      var name = ident();
      if (at('::')) {                                      // 类外定义的成员函数：int A::f(...) { }
        p++;
        var cls1 = structs.get(name);
        if (!cls1) throw CompileError('未知的类 ' + name, ln());
        var mn = ident();
        if (!cls1.methods[mn])
          cls1.methods[mn] = { name: name + '::' + mn, ret: ty0, arity: countParams(p), defined: false };
        if (parseFunction(cls1.methods[mn].name, ty0, cls1)) cls1.methods[mn].defined = true;
        continue;
      }
      if (at('(')) { parseFunction(name, ty0, null); continue; }
      p = save;
      globalVar(base);
    }

    // 检查成员函数是否都有定义
    structs.forEach(function (ty) {
      Object.keys(ty.methods).forEach(function (k) {
        if (!ty.methods[k].defined) throw CompileError('成员函数 ' + ty.methods[k].name + '() 只有声明没有定义', 1);
      });
      if (ty.ctor && !ty.ctor.defined) throw CompileError('构造函数 ' + ty.ctor.name + '() 只有声明没有定义', 1);
    });
    var hasMain = false;
    for (var fi = 0; fi < ast.funcs.length; fi++) if (ast.funcs[fi].name === 'main') hasMain = true;
    if (!hasMain) throw CompileError('程序缺少 main 函数', 1);
    return ast;
  }

  CE.TY = TY; CE.sizeOf = sizeOf; CE.alignOf = alignOf; CE.isPtr = isPtr; CE.isAggregate = isAggregate;
  CE.typeName = typeName; CE.layoutStruct = layoutStruct;
  CE.tokenize = tokenize; CE.parse = parse; CE.CompileError = CompileError;
})(typeof window !== 'undefined' ? window : globalThis);

/* ============================================================
 * CPU-EYE  代码生成：AST -> 目标指令流
 * 采用“累加器 + 求值栈”策略（与 chibicc 类似）：
 *   - 二元运算：先算右操作数压栈，再算左操作数，弹出到临时寄存器
 *   - 结果始终位于累加器（rax / eax / x0 / r0）
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});
  var MEM = CE.MEM;

  function alignTo(n, a) { return Math.floor((n + a - 1) / a) * a; }
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function log2(n) { return Math.round(Math.log2(n)); }

  var CMP_OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le' };
  var ALU_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
                  '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'sar' };

  function generate(ast, t) {
    var W = t.W;
    var sizeOf = CE.sizeOf, alignOf = CE.alignOf, isPtr = CE.isPtr, isAggregate = CE.isAggregate;
    var instrs = [];
    var symbols = {};
    var dataInit = [];
    var globalInfo = [];
    var labelSeq = 0;
    var curFn = null, curLine = 0;
    var breakStack = [], contStack = [];
    var funcNames = {}, funcMap = {};
    for (var i = 0; i < ast.funcs.length; i++) { funcNames[ast.funcs[i].name] = true; funcMap[ast.funcs[i].name] = ast.funcs[i]; }
    // 先把所有类的内存布局按本架构字长算出来（指针成员在 32/64 位下大小不同）
    (ast.structs || []).forEach(function (s) { sizeOf(s, W); });

    function emit(list) {
      for (var i = 0; i < list.length; i++) {
        var ins = list[i];
        ins.line = curLine;
        ins.fn = curFn ? curFn.name : '';
        ins.idx = instrs.length;
        ins.addr = MEM.CODE_BASE + instrs.length * 4;
        instrs.push(ins);
      }
    }
    function newLabel(tag) { return '.L' + tag + '_' + (labelSeq++); }

    /* ---------- 数据段 ---------- */
    var dp = MEM.DATA_BASE;
    ast.globals.forEach(function (gv) {
      var sz = sizeOf(gv.type, W), al = alignOf(gv.type, W);
      dp = alignTo(dp, Math.max(al, 4));
      symbols[gv.name] = dp;
      if (gv.type.kind === 'struct') {                       // 全局对象：逐成员布局
        var base = dp;
        for (var b = 0; b < sz; b++) dataInit.push({ addr: base + b, size: 1, val: 0 });
        gv.type.members.forEach(function (m, mi) {
          var msz = sizeOf(m.type, W);
          var isArr = m.type.kind === 'array';
          var mElem = isArr ? sizeOf(m.type.base, W) : (m.type.kind === 'struct' ? 4 : msz);
          if (mi < gv.init.length) {
            if (isArr || m.type.kind === 'struct')
              throw CE.CompileError('全局对象的初始化列表暂不支持数组或嵌套对象成员', 1);
            dataInit.push({ addr: base + m.offset, size: msz, val: gv.init[mi] });
          }
          globalInfo.push({ name: gv.name + '.' + m.name, addr: base + m.offset,
                            type: CE.typeName(m.type), elemSize: mElem,
                            count: Math.max(1, Math.floor(msz / mElem)), total: msz });
        });
        dp += sz;
        return;
      }
      var elemT = gv.type.kind === 'array' ? gv.type.base : gv.type;
      var esz = sizeOf(elemT, W);
      var count = gv.type.kind === 'array' ? gv.type.len : 1;
      for (var i = 0; i < count; i++) {
        dataInit.push({ addr: dp + i * esz, size: esz, val: i < gv.init.length ? gv.init[i] : 0 });
      }
      globalInfo.push({ name: gv.name, addr: dp, type: CE.typeName(gv.type), elemSize: esz, count: count, total: sz });
      dp += sz;
    });
    ast.strings.forEach(function (s) {
      symbols[s.label] = dp;
      var bytes = utf8Bytes(s.text);                       // 字符串按 UTF-8 存放
      for (var i = 0; i < bytes.length; i++) dataInit.push({ addr: dp + i, size: 1, val: bytes[i] });
      dataInit.push({ addr: dp + bytes.length, size: 1, val: 0 });
      globalInfo.push({ name: s.label, addr: dp, type: 'char[' + (bytes.length + 1) + ']',
                        elemSize: 1, count: bytes.length + 1, total: bytes.length + 1, str: s.text });
      dp = alignTo(dp + bytes.length + 1, 4);
    });
    var dataEnd = dp;

    /* ---------- 表达式 ---------- */
    function use64(a, b) {
      if (W !== 8) return false;
      return isPtr(a) || (b && isPtr(b));
    }

    function varSlot(v) {
      if (v.isGlobal) return emit(t.addrGlobal(v.name));
      return emit(t.addrLocal(v.offset, v.name));
    }
    function genAddr(node) {
      curLine = node.line || curLine;
      switch (node.k) {
        case 'var':
          return varSlot(node.v);
        case 'refvar':
          // 引用变量的槽里存的是被引用对象的地址，取出来就是左值地址
          varSlot(node.v);
          return emit(t.load(W));
        case 'member':
          sizeOf(node.cls, W);                       // 确保成员偏移已计算
          if (node.viaPtr) genExpr(node.obj); else genAddr(node.obj);
          if (node.m.offset) emit(t.addImm(node.m.offset, node.m.name));
          return;
        case 'deref':
          return genExpr(node.a, true);
        case 'strlit':
          return emit(t.addrGlobal(node.label));
      }
      throw CE.CompileError('该表达式不是左值，无法取地址', node.line);
    }
    function genLoadIfScalar(node) {
      if (isAggregate(node.type)) return;            // 数组和对象在表达式里就是它的地址
      emit(t.load(sizeOf(node.type, W)));
    }

    function genExpr(node, wantAddrOnly) {
      curLine = node.line || curLine;
      switch (node.k) {
        case 'num': return emit(t.imm(node.val));
        case 'sizeof': return emit(t.imm(sizeOf(node.ty, W)));

        case 'cast': {
          genExpr(node.a);
          var toK = node.ty.kind, fromK = node.a.type ? node.a.type.kind : 'int';
          // 只有窄化到 1 字节才需要真正产生指令，其余（指针之间、指针与整数）是纯类型层面的转换
          if ((toK === 'char' || toK === 'bool') && fromK !== 'char' && fromK !== 'bool') emit(t.castTo8());
          return;
        }
        case 'strlit': return emit(t.addrGlobal(node.label));

        case 'var': case 'refvar': case 'member':
          genAddr(node);
          return genLoadIfScalar(node);

        case 'deref':
          genExpr(node.a);
          return genLoadIfScalar(node);

        case 'addr': return genAddr(node.a);

        case 'bindref':                                     // int& r = x;  槽里存 x 的地址
          varSlot(node.v);
          emit(t.pushAcc());
          genAddr(node.a);
          emit(t.popTmp());
          return emit(t.store(W));

        case 'assign':
          genAddr(node.l);
          emit(t.pushAcc());
          genExpr(node.r);
          emit(t.popTmp());
          if (node.l.type.kind === 'struct') {              // 对象整体赋值：逐字节拷贝
            var csz = sizeOf(node.l.type, W);
            if (csz > 256) throw CE.CompileError('对象超过 256 字节，暂不支持整体赋值', node.line);
            return emit(t.copyMem(csz));
          }
          return emit(t.store(sizeOf(node.l.type, W)));

        case 'neg':  genExpr(node.a); return emit(t.negAcc());
        case 'bnot': genExpr(node.a); return emit(t.notAcc());

        case 'not':
          emit(t.imm(0));
          emit(t.pushAcc());
          genExpr(node.a);
          emit(t.popTmp());
          return emit(t.cmpset('eq', false));

        case 'logand': {
          var Lf = newLabel('and_false'), Le = newLabel('and_end');
          genExpr(node.l); emit(t.testZeroJump(Lf));
          genExpr(node.r); emit(t.testZeroJump(Lf));
          emit(t.imm(1)); emit(t.jmp(Le));
          emit(t.label(Lf)); emit(t.imm(0));
          return emit(t.label(Le));
        }
        case 'logor': {
          var L1 = newLabel('or_r'), L0 = newLabel('or_false'), L2 = newLabel('or_end');
          genExpr(node.l); emit(t.testZeroJump(L1));
          emit(t.imm(1)); emit(t.jmp(L2));
          emit(t.label(L1));
          genExpr(node.r); emit(t.testZeroJump(L0));
          emit(t.imm(1)); emit(t.jmp(L2));
          emit(t.label(L0)); emit(t.imm(0));
          return emit(t.label(L2));
        }

        case 'ptrdiff': {
          genExpr(node.r); emit(t.pushAcc());
          genExpr(node.l); emit(t.popTmp());
          emit(t.arith('sub', W === 8));
          var es = sizeOf(node.elem, W);
          if (es > 1) emit(t.sarAcc(log2(es)));
          return;
        }

        case 'bin': {
          // 指针 ± 整数：整数需要按元素大小缩放
          if (node.scale) {
            genExpr(node.r); emit(t.pushAcc());
            genExpr(node.l); emit(t.popTmp());
            emit(t.extTmp());
            var esz = sizeOf(node.scale, W);
            if (esz > 1) emit(t.shlTmp(log2(esz)));
            return emit(t.arith(node.op === '+' ? 'add' : 'sub', W === 8));
          }
          genExpr(node.r); emit(t.pushAcc());
          genExpr(node.l); emit(t.popTmp());
          var wide = use64(node.l.type, node.r.type);
          if (CMP_OPS[node.op]) return emit(t.cmpset(CMP_OPS[node.op], wide));
          var o = ALU_OPS[node.op];
          if (!o) throw CE.CompileError('不支持的运算符 ' + node.op, node.line);
          return emit(t.arith(o, wide));
        }

        case 'call': {
          var args = node.args, n = args.length;
          if (!funcNames[node.name] && node.name.indexOf('__print') !== 0)
            throw CE.CompileError('调用了未定义的函数 ' + node.name, node.line);
          var callee = funcMap[node.name];
          if (callee && callee.params.length !== n)
            throw CE.CompileError(node.name + '() 需要 ' + (callee.params.length - (callee.isMethod ? 1 : 0)) +
              ' 个参数，实际给了 ' + (n - (callee.isMethod ? 1 : 0)) + ' 个', node.line);
          if (t.maxRegArgs && n > t.maxRegArgs)
            throw CE.CompileError('参数个数超过 ' + t.maxRegArgs + ' 个（本模拟器限制）', node.line);
          // 引用形参传的是地址，普通形参传的是值
          function genArg(i) {
            var pt = callee && callee.params[i] ? callee.params[i].type : null;
            if (pt && pt.kind === 'ref') genAddr(args[i]);
            else genExpr(args[i]);
          }
          var i;
          if (t.argOrder === 'rtl') {
            for (i = n - 1; i >= 0; i--) { genArg(i); emit(t.pushArg()); }
            emit(t.call(node.name));
            emit(t.cleanup(n));
          } else {
            for (i = 0; i < n; i++) { genArg(i); emit(t.pushArg()); }
            for (i = n - 1; i >= 0; i--) emit(t.setArgReg(i));
            emit(t.call(node.name));
          }
          return;
        }
      }
      throw CE.CompileError('无法生成代码的表达式节点 ' + node.k, node.line);
    }

    /* ---------- 语句 ---------- */
    function genStmt(node) {
      curLine = node.line || curLine;
      switch (node.k) {
        case 'block':
          for (var i = 0; i < node.body.length; i++) genStmt(node.body[i]);
          return;
        case 'expr':
          return genExpr(node.e);
        case 'ret':
          if (node.e) genExpr(node.e);
          curLine = node.line;
          return emit(t.jmp('.L.ret.' + curFn.name));
        case 'if': {
          var Le = newLabel('else'), Lend = newLabel('endif');
          genExpr(node.c);
          emit(t.testZeroJump(node.el ? Le : Lend));
          genStmt(node.th);
          if (node.el) {
            emit(t.jmp(Lend));
            emit(t.label(Le));
            genStmt(node.el);
          }
          return emit(t.label(Lend));
        }
        case 'while': {
          var Lb = newLabel('while'), Lc = newLabel('cont'), Lx = newLabel('wend');
          emit(t.label(Lb));
          curLine = node.c.line || node.line;
          genExpr(node.c);
          emit(t.testZeroJump(Lx));
          breakStack.push(Lx); contStack.push(Lc);
          genStmt(node.body);
          breakStack.pop(); contStack.pop();
          emit(t.label(Lc));
          emit(t.jmp(Lb));
          return emit(t.label(Lx));
        }
        case 'dowhile': {
          var Db = newLabel('do'), Dc = newLabel('cont'), Dx = newLabel('doend');
          emit(t.label(Db));
          breakStack.push(Dx); contStack.push(Dc);
          genStmt(node.body);
          breakStack.pop(); contStack.pop();
          emit(t.label(Dc));
          genExpr(node.c);
          emit(t.testZeroJump(Dx));
          emit(t.jmp(Db));
          return emit(t.label(Dx));
        }
        case 'for': {
          var Fb = newLabel('for'), Fc = newLabel('cont'), Fx = newLabel('forend');
          if (node.init) genStmt(node.init);
          emit(t.label(Fb));
          if (node.c) { curLine = node.c.line || node.line; genExpr(node.c); emit(t.testZeroJump(Fx)); }
          breakStack.push(Fx); contStack.push(Fc);
          genStmt(node.body);
          breakStack.pop(); contStack.pop();
          emit(t.label(Fc));
          if (node.step) { curLine = node.step.line || node.line; genExpr(node.step); }
          emit(t.jmp(Fb));
          return emit(t.label(Fx));
        }
        case 'break':
          if (!breakStack.length) throw CE.CompileError('break 不在循环内', node.line);
          return emit(t.jmp(breakStack[breakStack.length - 1]));
        case 'continue':
          if (!contStack.length) throw CE.CompileError('continue 不在循环内', node.line);
          return emit(t.jmp(contStack[contStack.length - 1]));
      }
      throw CE.CompileError('无法生成代码的语句 ' + node.k, node.line);
    }

    /* ---------- 函数 ---------- */
    var frames = {};
    ast.funcs.forEach(function (fn) {
      curFn = fn;
      curLine = fn.line;
      var off = 0;
      var vars = [];
      fn.locals.forEach(function (v) {
        var sz = sizeOf(v.type, W), al = alignOf(v.type, W);
        off += sz;
        off = alignTo(off, Math.max(al, 4));
        v.offset = off;
        vars.push({ name: v.name, offset: off, size: sz, type: CE.typeName(v.type),
                    elemSize: sizeOf(v.type.kind === 'array' ? v.type.base : v.type, W),
                    count: v.type.kind === 'array' ? v.type.len : 1,
                    isParam: fn.params.indexOf(v) >= 0 });
        if (v.type.kind === 'struct') {                      // 对象：在栈视图里逐成员标注
          v.type.members.forEach(function (m) {
            var msz = sizeOf(m.type, W);
            var isArr = m.type.kind === 'array';
            vars.push({ name: v.name + '.' + m.name, offset: v.offset - m.offset, size: msz,
                        type: CE.typeName(m.type),
                        elemSize: isArr ? sizeOf(m.type.base, W) : msz,
                        count: isArr ? m.type.len : 1, isParam: false });
          });
        }
      });
      var frameSize = alignTo(off, 16);
      frames[fn.name] = { frameSize: frameSize, vars: vars, entry: 0 };

      emit(t.funcStart(fn.name, frameSize));
      fn.params.forEach(function (pv, i) {
        emit(t.paramStore(i, pv.offset, sizeOf(pv.type, W)));
      });
      genStmt(fn.body);
      curLine = 0;
      emit(t.funcEnd(fn.name));
      curFn = null;
    });

    /* ---------- 标签表 ---------- */
    var labels = {};
    for (var i2 = 0; i2 < instrs.length; i2++) {
      if (instrs[i2].kind === 'label') labels[instrs[i2].name] = i2;
    }
    // 校验跳转目标
    for (var i3 = 0; i3 < instrs.length; i3++) {
      var ins = instrs[i3];
      if ((ins.kind === 'jmp' || ins.kind === 'br' || ins.kind === 'brz') && !(ins.label in labels))
        throw new Error('内部错误：未解析的标签 ' + ins.label);
    }
    if (!('main' in labels)) throw CE.CompileError('缺少 main 函数', 1);
    Object.keys(frames).forEach(function (fname) { frames[fname].entry = labels[fname]; });

    return {
      arch: t.id, target: t, instrs: instrs, labels: labels, symbols: symbols,
      dataInit: dataInit, globalInfo: globalInfo, dataEnd: dataEnd,
      frames: frames, W: W,
      asmText: instrs.map(function (x) { return (x.kind === 'label' || x.kind === 'dir') ? x.text : '        ' + x.text; }).join('\n')
    };
  }

  CE.generate = generate;
  CE.compile = function (src, archId) {
    var toks = CE.tokenize(src);
    var ast = CE.parse(toks);
    return CE.generate(ast, CE.makeTarget(archId));
  };
})(typeof window !== 'undefined' ? window : globalThis);

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
  function log2(n) { return Math.round(Math.log2(n)); }

  var CMP_OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le' };
  var ALU_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
                  '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'sar' };

  function generate(ast, t) {
    var W = t.W;
    var sizeOf = CE.sizeOf, alignOf = CE.alignOf, isPtr = CE.isPtr;
    var instrs = [];
    var symbols = {};
    var dataInit = [];
    var globalInfo = [];
    var labelSeq = 0;
    var curFn = null, curLine = 0;
    var breakStack = [], contStack = [];
    var funcNames = {};
    for (var i = 0; i < ast.funcs.length; i++) funcNames[ast.funcs[i].name] = true;

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
      for (var i = 0; i < s.text.length; i++) dataInit.push({ addr: dp + i, size: 1, val: s.text.charCodeAt(i) & 0xff });
      dataInit.push({ addr: dp + s.text.length, size: 1, val: 0 });
      globalInfo.push({ name: s.label, addr: dp, type: 'char[' + (s.text.length + 1) + ']', elemSize: 1, count: s.text.length + 1, total: s.text.length + 1, str: s.text });
      dp = alignTo(dp + s.text.length + 1, 4);
    });
    var dataEnd = dp;

    /* ---------- 表达式 ---------- */
    function use64(a, b) {
      if (W !== 8) return false;
      return isPtr(a) || (b && isPtr(b));
    }

    function genAddr(node) {
      curLine = node.line || curLine;
      switch (node.k) {
        case 'var':
          if (node.v.isGlobal) return emit(t.addrGlobal(node.v.name));
          return emit(t.addrLocal(node.v.offset, node.v.name));
        case 'deref':
          return genExpr(node.a, true);
        case 'strlit':
          return emit(t.addrGlobal(node.label));
      }
      throw CE.CompileError('该表达式不是左值，无法取地址', node.line);
    }

    function genExpr(node, wantAddrOnly) {
      curLine = node.line || curLine;
      switch (node.k) {
        case 'num': return emit(t.imm(node.val));
        case 'sizeof': return emit(t.imm(sizeOf(node.ty, W)));
        case 'strlit': return emit(t.addrGlobal(node.label));

        case 'var':
          genAddr(node);
          if (node.type.kind === 'array') return;           // 数组退化为地址
          return emit(t.load(sizeOf(node.type, W)));

        case 'deref':
          genExpr(node.a);
          if (node.type.kind === 'array') return;
          return emit(t.load(sizeOf(node.type, W)));

        case 'addr': return genAddr(node.a);

        case 'assign':
          genAddr(node.l);
          emit(t.pushAcc());
          genExpr(node.r);
          emit(t.popTmp());
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
          if (t.maxRegArgs && n > t.maxRegArgs)
            throw CE.CompileError('参数个数超过 ' + t.maxRegArgs + ' 个（本模拟器限制）', node.line);
          var i;
          if (t.argOrder === 'rtl') {
            for (i = n - 1; i >= 0; i--) { genExpr(args[i]); emit(t.pushArg()); }
            emit(t.call(node.name));
            emit(t.cleanup(n));
          } else {
            for (i = 0; i < n; i++) { genExpr(args[i]); emit(t.pushArg()); }
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

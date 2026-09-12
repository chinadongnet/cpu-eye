/* ============================================================
 * CPU-EYE  目标后端：x86-32 / x86-64 / ARM32 / ARM64
 * 每个后端负责“发射”一条条指令对象：
 *   { kind, ...语义字段, text:'可读汇编' }
 * 模拟器只按 kind 执行，text 仅用于显示。
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});

  var MEM = { SIZE: 0x10000, DATA_BASE: 0x1000, STACK_TOP: 0xF000, CODE_BASE: 0x400000 };
  CE.MEM = MEM;

  function pad(s, n) { while (s.length < n) s += ' '; return s; }
  function op(mnemonic, operands) { return operands ? pad(mnemonic, 8) + operands : mnemonic; }
  function mk(kind, f, text) { f = f || {}; f.kind = kind; f.text = text; return f; }
  function hexd(d) { return (d < 0 ? '-' : '+') + '0x' + Math.abs(d).toString(16); }
  function sd(d) { return (d < 0 ? '-' : '') + Math.abs(d); }

  var INV = { eq: 'ne', ne: 'eq', lt: 'ge', ge: 'lt', le: 'gt', gt: 'le' };

  /* =======================  x86 家族  ======================= */
  function makeX86(bits) {
    var W = bits === 64 ? 8 : 4;
    var A = bits === 64 ? 'rax' : 'eax';       // 累加器（字长）
    var A32 = 'eax';
    var C = bits === 64 ? 'rcx' : 'ecx';       // 临时寄存器（字长）
    var C32 = 'ecx';
    var SP = bits === 64 ? 'rsp' : 'esp';
    var FP = bits === 64 ? 'rbp' : 'ebp';
    var WS = bits === 64 ? 'qword' : 'dword';
    var argR = bits === 64 ? ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'] : [];
    var argR32 = bits === 64 ? ['edi', 'esi', 'edx', 'ecx', 'r8d', 'r9d'] : [];
    var setcc = { eq: 'sete', ne: 'setne', lt: 'setl', le: 'setle', gt: 'setg', ge: 'setge' };
    var jcc = { eq: 'je', ne: 'jne', lt: 'jl', le: 'jle', gt: 'jg', ge: 'jge' };

    function memref(base, disp, size) {
      var w = size === 64 ? 'qword' : size === 32 ? 'dword' : 'byte';
      return w + ' [' + base + (disp ? ' ' + hexd(disp) : '') + ']';
    }
    function regFor(size) { return size === 64 ? A : size === 32 ? 'eax' : 'al'; }
    function tmpFor(size) { return size === 64 ? C : size === 32 ? 'ecx' : 'cl'; }

    return {
      id: bits === 64 ? 'x86-64' : 'x86-32',
      title: bits === 64 ? 'x86-64 (AMD64)' : 'x86-32 (IA-32)',
      family: 'x86',
      bits: bits, W: W,
      syntax: 'Intel 语法 · ' + (bits === 64 ? 'System V AMD64 ABI' : 'cdecl 调用约定'),
      acc: A, accName: A,
      sp: SP, fp: FP,
      argOrder: bits === 64 ? 'ltr' : 'rtl',   // 32 位用栈传参：从右往左压栈
      argRegs: argR,
      maxRegArgs: bits === 64 ? 6 : 0,
      callerCleanup: bits !== 64,
      retVia: 'stack',
      flagStyle: 'x86',
      flagNames: ['CF', 'ZF', 'SF', 'OF'],
      regs: bits === 64
        ? ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11']
        : ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'],
      alias: bits === 64
        ? { eax: 'rax', ax: 'rax', al: 'rax', ebx: 'rbx', ecx: 'rcx', cl: 'rcx', edx: 'rdx', dl: 'rdx',
            esi: 'rsi', edi: 'rdi', ebp: 'rbp', esp: 'rsp', r8d: 'r8', r9d: 'r9', r10d: 'r10', r11d: 'r11' }
        : { al: 'eax', cl: 'ecx', dl: 'edx', ax: 'eax' },
      pcName: bits === 64 ? 'rip' : 'eip',

      /* ---- 函数框架 ---- */
      funcStart: function (name, frameSize) {
        var r = [mk('dir', {}, '.globl  ' + name), mk('label', { name: name }, name + ':')];
        r.push(mk('push', { src: FP, size: bits }, op('push', FP)));
        r.push(mk('mov', { dst: FP, src: SP, size: bits }, op('mov', FP + ', ' + SP)));
        if (frameSize) r.push(mk('alu', { o: 'sub', dst: SP, a: SP, imm: frameSize, size: bits }, op('sub', SP + ', ' + frameSize)));
        return r;
      },
      paramStore: function (i, off, size) {
        // size: 变量字节数
        if (bits === 64) {
          var src = size === 8 ? argR[i] : size === 1 ? argR32[i] : argR32[i];
          var bs = size === 8 ? 64 : size === 1 ? 8 : 32;
          return [mk('str', { src: src, base: FP, disp: -off, size: bs, mode: 'off' },
            op('mov', memref(FP, -off, bs) + ', ' + src))];
        }
        var srcOff = 8 + i * 4;
        var bs2 = size === 1 ? 8 : 32;
        return [
          mk('ldr', { dst: 'eax', base: FP, disp: srcOff, size: 32, signed: true, mode: 'off' },
            op('mov', 'eax, ' + memref(FP, srcOff, 32))),
          mk('str', { src: bs2 === 8 ? 'al' : 'eax', base: FP, disp: -off, size: bs2, mode: 'off' },
            op('mov', memref(FP, -off, bs2) + ', ' + (bs2 === 8 ? 'al' : 'eax')))
        ];
      },
      funcEnd: function (name) {
        return [
          mk('label', { name: '.L.ret.' + name }, '.L.ret.' + name + ':'),
          mk('mov', { dst: SP, src: FP, size: bits }, op('mov', SP + ', ' + FP)),
          mk('pop', { dst: FP, size: bits }, op('pop', FP)),
          mk('ret', {}, 'ret')
        ];
      },

      /* ---- 基本操作 ---- */
      imm: function (v) { return [mk('imm', { dst: A, val: v, size: bits }, op('mov', A + ', ' + v))]; },
      pushAcc: function () { return [mk('push', { src: A, size: bits }, op('push', A))]; },
      popTmp: function () { return [mk('pop', { dst: C, size: bits }, op('pop', C))]; },
      popTo: function (reg) { return [mk('pop', { dst: reg, size: bits }, op('pop', reg))]; },
      addrLocal: function (off, nameHint) {
        return [mk('lea', { dst: A, base: FP, disp: -off, size: bits },
          op('lea', A + ', [' + FP + ' ' + hexd(-off) + ']') + '        ; &' + nameHint)];
      },
      addrGlobal: function (sym) {
        if (bits === 64) return [mk('lea', { dst: A, sym: sym, disp: 0, size: 64 }, op('lea', 'rax, [rip + ' + sym + ']'))];
        return [mk('lea', { dst: A, sym: sym, disp: 0, size: 32 }, op('mov', 'eax, OFFSET ' + sym))];
      },
      load: function (size) {
        if (size === 1) return [mk('ldr', { dst: 'eax', base: A, disp: 0, size: 8, signed: true, mode: 'off' }, op('movsx', 'eax, ' + memref(A, 0, 8)))];
        if (size === 8) return [mk('ldr', { dst: 'rax', base: A, disp: 0, size: 64, signed: true, mode: 'off' }, op('mov', 'rax, ' + memref(A, 0, 64)))];
        return [mk('ldr', { dst: 'eax', base: A, disp: 0, size: 32, signed: true, mode: 'off' }, op('mov', 'eax, ' + memref(A, 0, 32)))];
      },
      store: function (size) {
        var bs = size === 8 ? 64 : size === 1 ? 8 : 32;
        var r = regFor(bs);
        return [mk('str', { src: r, base: C, disp: 0, size: bs, mode: 'off' }, op('mov', memref(C, 0, bs) + ', ' + r))];
      },
      extTmp: function () {
        if (bits === 64) return [mk('alu', { o: 'sext32', dst: C, a: C32, size: 64 }, op('movsxd', C + ', ' + C32))];
        return [];
      },
      shlTmp: function (k) { return [mk('alu', { o: 'shl', dst: C, a: C, imm: k, size: bits }, op('shl', C + ', ' + k))]; },
      sarAcc: function (k) { return [mk('alu', { o: 'sar', dst: A, a: A, imm: k, size: bits }, op('sar', A + ', ' + k))]; },
      // 累加器加上一个常量偏移（用于取成员地址）
      addImm: function (n, note) {
        return [mk('alu', { o: 'add', dst: A, a: A, imm: n, size: bits },
          op('add', A + ', ' + n) + (note ? '        ; ->' + note : ''))];
      },
      // 结构体拷贝：源地址在累加器，目标地址在临时寄存器
      copyMem: function (size) {
        var r = [], off = 0, sc = bits === 64 ? 'edx' : 'edx';
        while (size - off >= 4) {
          r.push(mk('ldr', { dst: sc, base: A, disp: off, size: 32, signed: false, mode: 'off' },
            op('mov', sc + ', ' + memref(A, off, 32))));
          r.push(mk('str', { src: sc, base: C, disp: off, size: 32, mode: 'off' },
            op('mov', memref(C, off, 32) + ', ' + sc)));
          off += 4;
        }
        while (off < size) {
          r.push(mk('ldr', { dst: 'dl', base: A, disp: off, size: 8, signed: false, mode: 'off' },
            op('mov', 'dl, ' + memref(A, off, 8))));
          r.push(mk('str', { src: 'dl', base: C, disp: off, size: 8, mode: 'off' },
            op('mov', memref(C, off, 8) + ', dl')));
          off += 1;
        }
        return r;
      },
      negAcc: function () { return [mk('alu', { o: 'neg', dst: 'eax', a: 'eax', size: 32 }, op('neg', 'eax'))]; },
      // 窄化类型转换：只保留低 8 位并符号扩展
      castTo8: function () { return [mk('alu', { o: 'sext8', dst: 'eax', a: 'eax', size: 32 }, op('movsx', 'eax, al'))]; },
      notAcc: function () { return [mk('alu', { o: 'not', dst: 'eax', a: 'eax', size: 32 }, op('not', 'eax'))]; },

      arith: function (o, use64) {
        var size = use64 ? 64 : 32;
        var a = use64 ? A : 'eax', c = use64 ? C : 'ecx';
        var x86 = { add: 'add', sub: 'sub', mul: 'imul', and: 'and', or: 'or', xor: 'xor' };
        if (x86[o]) return [mk('alu', { o: o, dst: a, a: a, b: c, size: size }, op(x86[o], a + ', ' + c))];
        if (o === 'div' || o === 'mod') {
          var r = [mk('nop', {}, use64 ? 'cqo' : 'cdq')];
          r.push(mk('idiv', { src: c, size: size }, op('idiv', c)));
          if (o === 'mod') r.push(mk('mov', { dst: a, src: use64 ? 'rdx' : 'edx', size: size }, op('mov', a + ', ' + (use64 ? 'rdx' : 'edx'))));
          return r;
        }
        if (o === 'shl' || o === 'sar') {
          return [mk('alu', { o: o, dst: a, a: a, b: 'cl', size: size }, op(o === 'shl' ? 'shl' : 'sar', a + ', cl'))];
        }
        throw new Error('未知运算 ' + o);
      },
      cmpset: function (cond, use64) {
        var size = use64 ? 64 : 32;
        var a = use64 ? A : 'eax', c = use64 ? C : 'ecx';
        return [
          mk('cmp', { a: a, b: c, size: size }, op('cmp', a + ', ' + c)),
          mk('set', { cond: cond, dst: 'eax' }, op(setcc[cond], 'al')),
          mk('nop', {}, op('movzx', 'eax, al'))
        ];
      },
      testZeroJump: function (label) {
        return [
          mk('cmp', { a: A, imm: 0, size: bits }, op('cmp', A + ', 0')),
          mk('br', { cond: 'eq', label: label }, op('je', label))
        ];
      },
      jmp: function (label) { return [mk('jmp', { label: label }, op('jmp', label))]; },
      label: function (name) { return [mk('label', { name: name }, name + ':')]; },
      call: function (name) { return [mk('call', { target: name }, op('call', name))]; },
      pushArg: function () { return [mk('push', { src: A, size: bits }, op('push', A))]; },
      setArgReg: function (i) {
        return [mk('pop', { dst: argR[i], size: bits }, op('pop', argR[i]))];
      },
      cleanup: function (nargs) {
        return nargs ? [mk('alu', { o: 'add', dst: SP, a: SP, imm: nargs * 4, size: bits }, op('add', SP + ', ' + nargs * 4))] : [];
      },
      comment: function (t) { return [mk('dir', {}, '; ' + t)]; }
    };
  }

  /* =======================  ARM 家族  ======================= */
  function makeArm(bits) {
    var is64 = bits === 64;
    var W = is64 ? 8 : 4;
    var A = is64 ? 'x0' : 'r0', A32 = is64 ? 'w0' : 'r0';
    var B = is64 ? 'x1' : 'r1', B32 = is64 ? 'w1' : 'r1';
    var T2 = is64 ? 'x2' : 'r2', T2_32 = is64 ? 'w2' : 'r2';
    var SP = 'sp', FP = is64 ? 'x29' : 'fp', LR = is64 ? 'x30' : 'lr';
    var argR = is64 ? ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'] : ['r0', 'r1', 'r2', 'r3'];
    var argR32 = is64 ? ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'] : argR;
    var PUSH_STEP = is64 ? 16 : 4;

    function R(size) { return size === 64 ? A : A32; }

    return {
      id: is64 ? 'arm64' : 'arm32',
      title: is64 ? 'ARM64 (AArch64)' : 'ARM32 (ARMv7-A)',
      family: 'arm',
      bits: bits, W: W,
      syntax: is64 ? 'AArch64 · AAPCS64 调用约定' : 'ARM A32 · AAPCS 调用约定',
      acc: A, accName: A,
      sp: SP, fp: FP, lr: LR,
      argOrder: 'ltr',
      argRegs: argR,
      maxRegArgs: is64 ? 8 : 4,
      callerCleanup: false,
      retVia: 'lr',
      flagStyle: 'arm',
      flagNames: ['N', 'Z', 'C', 'V'],
      regs: is64
        ? ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x19', 'x29', 'x30', 'sp']
        : ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'fp', 'ip', 'sp', 'lr'],
      alias: is64
        ? { w0: 'x0', w1: 'x1', w2: 'x2', w3: 'x3', w4: 'x4', w5: 'x5', w6: 'x6', w7: 'x7', w8: 'x8', w9: 'x9', w19: 'x19', w29: 'x29', w30: 'x30' }
        : { r11: 'fp', r12: 'ip', r13: 'sp', r14: 'lr' },
      pcName: 'pc',

      funcStart: function (name, frameSize) {
        var r = [mk('dir', {}, '.globl  ' + name), mk('label', { name: name }, name + ':')];
        if (is64) {
          r.push(mk('stp', { r1: 'x29', r2: 'x30', base: SP, disp: -16, mode: 'pre', size: 64 }, op('stp', 'x29, x30, [sp, #-16]!')));
          r.push(mk('mov', { dst: 'x29', src: SP, size: 64 }, op('mov', 'x29, sp')));
        } else {
          r.push(mk('pushm', { regs: ['fp', 'lr'], size: 32 }, op('push', '{fp, lr}')));
          r.push(mk('mov', { dst: 'fp', src: SP, size: 32 }, op('mov', 'fp, sp')));
        }
        if (frameSize) r.push(mk('alu', { o: 'sub', dst: SP, a: SP, imm: frameSize, size: bits }, op('sub', SP + ', ' + SP + ', #' + frameSize)));
        return r;
      },
      paramStore: function (i, off, size) {
        var bs = size === 8 ? 64 : size === 1 ? 8 : 32;
        var src = bs === 64 ? argR[i] : argR32[i];
        var mn = bs === 8 ? 'strb' : 'str';
        return [mk('str', { src: src, base: FP, disp: -off, size: bs, mode: 'off' },
          op(mn, src + ', [' + FP + ', #' + sd(-off) + ']'))];
      },
      funcEnd: function (name) {
        var r = [mk('label', { name: '.L.ret.' + name }, '.L.ret.' + name + ':')];
        if (is64) {
          r.push(mk('mov', { dst: SP, src: 'x29', size: 64 }, op('mov', 'sp, x29')));
          r.push(mk('ldp', { r1: 'x29', r2: 'x30', base: SP, disp: 16, mode: 'post', size: 64 }, op('ldp', 'x29, x30, [sp], #16')));
          r.push(mk('ret', {}, 'ret'));
        } else {
          r.push(mk('mov', { dst: SP, src: 'fp', size: 32 }, op('mov', 'sp, fp')));
          r.push(mk('popm', { regs: ['fp', 'lr'], size: 32 }, op('pop', '{fp, lr}')));
          r.push(mk('ret', {}, op('bx', 'lr')));
        }
        return r;
      },

      imm: function (v) {
        if (v >= 0 && v <= 65535) return [mk('imm', { dst: A32, val: v, size: 32 }, op('mov', A32 + ', #' + v))];
        if (v < 0 && v >= -65535) return [mk('imm', { dst: A32, val: v, size: 32 }, op('mov', A32 + ', #' + v))];
        return [mk('imm', { dst: A, val: v, size: bits }, op('ldr', A + ', =' + v))];
      },
      pushAcc: function () {
        return [mk('str', { src: A, base: SP, disp: -PUSH_STEP, size: bits, mode: 'pre' },
          op('str', A + ', [sp, #-' + PUSH_STEP + ']!'))];
      },
      popTmp: function () {
        return [mk('ldr', { dst: B, base: SP, disp: PUSH_STEP, size: bits, signed: false, mode: 'post' },
          op('ldr', B + ', [sp], #' + PUSH_STEP))];
      },
      popTo: function (reg) {
        return [mk('ldr', { dst: reg, base: SP, disp: PUSH_STEP, size: bits, signed: false, mode: 'post' },
          op('ldr', reg + ', [sp], #' + PUSH_STEP))];
      },
      addrLocal: function (off, nameHint) {
        return [mk('lea', { dst: A, base: FP, disp: -off, size: bits },
          op('sub', A + ', ' + FP + ', #' + off) + '       // &' + nameHint)];
      },
      addrGlobal: function (sym) {
        if (is64) return [
          mk('lea', { dst: A, sym: sym, disp: 0, page: true, size: 64 }, op('adrp', 'x0, ' + sym)),
          mk('lo12', { dst: A, a: A, sym: sym, size: 64 }, op('add', 'x0, x0, :lo12:' + sym))
        ];
        return [mk('lea', { dst: A, sym: sym, disp: 0, size: 32 }, op('ldr', 'r0, =' + sym))];
      },
      load: function (size) {
        if (size === 1) return [mk('ldr', { dst: A32, base: A, disp: 0, size: 8, signed: true, mode: 'off' }, op('ldrsb', A32 + ', [' + A + ']'))];
        if (size === 8) return [mk('ldr', { dst: A, base: A, disp: 0, size: 64, signed: true, mode: 'off' }, op('ldr', A + ', [' + A + ']'))];
        return [mk('ldr', { dst: A32, base: A, disp: 0, size: 32, signed: true, mode: 'off' }, op('ldr', A32 + ', [' + A + ']'))];
      },
      store: function (size) {
        var bs = size === 8 ? 64 : size === 1 ? 8 : 32;
        var src = bs === 64 ? A : A32;
        var mn = bs === 8 ? 'strb' : 'str';
        return [mk('str', { src: src, base: B, disp: 0, size: bs, mode: 'off' }, op(mn, src + ', [' + B + ']'))];
      },
      extTmp: function () {
        if (is64) return [mk('alu', { o: 'sext32', dst: 'x1', a: 'w1', size: 64 }, op('sxtw', 'x1, w1'))];
        return [];
      },
      shlTmp: function (k) { return [mk('alu', { o: 'shl', dst: B, a: B, imm: k, size: bits }, op('lsl', B + ', ' + B + ', #' + k))]; },
      sarAcc: function (k) { return [mk('alu', { o: 'sar', dst: A, a: A, imm: k, size: bits }, op('asr', A + ', ' + A + ', #' + k))]; },
      // 累加器加上一个常量偏移（用于取成员地址）
      addImm: function (n, note) {
        return [mk('alu', { o: 'add', dst: A, a: A, imm: n, size: bits },
          op('add', A + ', ' + A + ', #' + n) + (note ? '       // ->' + note : ''))];
      },
      // 结构体拷贝：源地址在累加器，目标地址在临时寄存器
      copyMem: function (size) {
        var r = [], off = 0;
        var w32 = is64 ? 'w2' : 'r2';
        while (size - off >= 4) {
          r.push(mk('ldr', { dst: w32, base: A, disp: off, size: 32, signed: false, mode: 'off' },
            op('ldr', w32 + ', [' + A + ', #' + off + ']')));
          r.push(mk('str', { src: w32, base: B, disp: off, size: 32, mode: 'off' },
            op('str', w32 + ', [' + B + ', #' + off + ']')));
          off += 4;
        }
        while (off < size) {
          r.push(mk('ldr', { dst: w32, base: A, disp: off, size: 8, signed: false, mode: 'off' },
            op('ldrb', w32 + ', [' + A + ', #' + off + ']')));
          r.push(mk('str', { src: w32, base: B, disp: off, size: 8, mode: 'off' },
            op('strb', w32 + ', [' + B + ', #' + off + ']')));
          off += 1;
        }
        return r;
      },
      negAcc: function () { return [mk('alu', { o: 'neg', dst: A32, a: A32, size: 32 }, op('neg', A32 + ', ' + A32))]; },
      // 窄化类型转换：只保留低 8 位并符号扩展
      castTo8: function () { return [mk('alu', { o: 'sext8', dst: A32, a: A32, size: 32 }, op('sxtb', A32 + ', ' + A32))]; },
      notAcc: function () { return [mk('alu', { o: 'not', dst: A32, a: A32, size: 32 }, op('mvn', A32 + ', ' + A32))]; },

      arith: function (o, use64) {
        var size = use64 ? 64 : 32;
        var a = use64 ? A : A32, b = use64 ? B : B32, t2 = use64 ? T2 : T2_32;
        var mn = { add: 'add', sub: 'sub', mul: 'mul', and: 'and', or: 'orr', xor: 'eor', div: 'sdiv', shl: 'lsl', sar: 'asr' };
        if (o === 'mod') {
          return [
            mk('alu', { o: 'div', dst: t2, a: a, b: b, size: size }, op('sdiv', t2 + ', ' + a + ', ' + b)),
            mk('msub', { dst: a, m1: t2, m2: b, sub: a, size: size },
               op(is64 ? 'msub' : 'mls', is64 ? (a + ', ' + t2 + ', ' + b + ', ' + a) : (a + ', ' + t2 + ', ' + b + ', ' + a)))
          ];
        }
        if (!mn[o]) throw new Error('未知运算 ' + o);
        return [mk('alu', { o: o, dst: a, a: a, b: b, size: size }, op(mn[o], a + ', ' + a + ', ' + b))];
      },
      cmpset: function (cond, use64) {
        var size = use64 ? 64 : 32;
        var a = use64 ? A : A32, b = use64 ? B : B32;
        var r = [mk('cmp', { a: a, b: b, size: size }, op('cmp', a + ', ' + b))];
        if (is64) {
          r.push(mk('set', { cond: cond, dst: 'w0' }, op('cset', 'w0, ' + cond)));
        } else {
          r.push(mk('movcc', { cond: cond, dst: 'r0', val: 1, size: 32 }, op('mov' + cond, 'r0, #1')));
          r.push(mk('movcc', { cond: INV[cond], dst: 'r0', val: 0, size: 32 }, op('mov' + INV[cond], 'r0, #0')));
        }
        return r;
      },
      testZeroJump: function (label) {
        if (is64) return [mk('brz', { reg: A, label: label, size: 64 }, op('cbz', A + ', ' + label))];
        return [
          mk('cmp', { a: A, imm: 0, size: 32 }, op('cmp', A + ', #0')),
          mk('br', { cond: 'eq', label: label }, op('beq', label))
        ];
      },
      jmp: function (label) { return [mk('jmp', { label: label }, op('b', label))]; },
      label: function (name) { return [mk('label', { name: name }, name + ':')]; },
      call: function (name) { return [mk('call', { target: name }, op('bl', name))]; },
      pushArg: function () { return this.pushAcc(); },
      setArgReg: function (i) { return this.popTo(argR[i]); },
      cleanup: function () { return []; },
      comment: function (t) { return [mk('dir', {}, '// ' + t)]; }
    };
  }

  var FACTORY = {
    'x86-32': function () { return makeX86(32); },
    'x86-64': function () { return makeX86(64); },
    'arm32':  function () { return makeArm(32); },
    'arm64':  function () { return makeArm(64); }
  };
  CE.ARCH_IDS = ['x86-32', 'x86-64', 'arm32', 'arm64'];
  CE.makeTarget = function (id) {
    if (!FACTORY[id]) throw new Error('未知架构 ' + id);
    return FACTORY[id]();
  };
  CE.mkInstr = mk;
  CE.asmOp = op;
})(typeof window !== 'undefined' ? window : globalThis);

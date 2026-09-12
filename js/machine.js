/* ============================================================
 * CPU-EYE  指令级 CPU 模拟器
 * 逐条执行指令，记录寄存器/内存/标志位的每一次变化，
 * 并给出本条指令走过的数据通路阶段，供界面动态展示。
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});
  var MEM = CE.MEM;
  var SENTINEL = 0xDEAD0000;
  var MAX_STEPS = 4000000;

  var TWO32 = 4294967296;
  function u32(v) { v = v % TWO32; return v < 0 ? v + TWO32 : v; }
  function sgn(v, size) {
    if (size === 32) { var x = u32(v); return x >= 2147483648 ? x - TWO32 : x; }
    if (size === 8) { var b = ((v % 256) + 256) % 256; return b >= 128 ? b - 256 : b; }
    return v;
  }
  function uns(v, size) {
    if (size === 32) return u32(v);
    if (size === 8) return ((v % 256) + 256) % 256;
    return v < 0 ? v + 18446744073709551616 : v;
  }

  function RuntimeError(msg) { var e = new Error(msg); e.isRuntime = true; return e; }

  function create(prog) {
    var m = {
      prog: prog,
      arch: prog.target,
      instrs: prog.instrs,
      labels: prog.labels,
      symbols: prog.symbols,
      alias: prog.target.alias || {},
      W: prog.W,
      regs: {},
      flags: { N: false, Z: false, C: false, V: false },
      mem: new Uint8Array(MEM.SIZE),
      pc: 0,
      count: 0,
      output: '',
      halted: false,
      error: null,
      exitCode: null,
      callStack: [],
      ef: null,
      maxSp: MEM.STACK_TOP
    };
    reset(m);
    return m;
  }

  function reset(m) {
    var a = m.arch;
    m.regs = {};
    a.regs.forEach(function (r) { m.regs[r] = 0; });
    ['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','eax','ebx','ecx','edx','esi','edi','ebp','esp',
     'x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x19','x29','x30',
     'r0','r1','r2','r3','r4','r5','r6','r7','r8','r9','r10','fp','ip','lr','sp',
     'pc','rip','eip'].forEach(function (r) {
      if (!(r in m.regs)) m.regs[r] = 0;
    });
    m.flags = { N: false, Z: false, C: false, V: false };
    m.mem = new Uint8Array(MEM.SIZE);
    m.prog.dataInit.forEach(function (d) { rawWrite(m, d.addr, d.size * 8, d.val); });
    m.pc = m.labels['main'];
    m.count = 0;
    m.output = '';
    m.halted = false;
    m.error = null;
    m.exitCode = null;
    m.callStack = [{ name: 'main', retIdx: -1, sp: MEM.STACK_TOP, line: 0 }];
    m.ef = null;
    m.maxSp = MEM.STACK_TOP;

    var sp = MEM.STACK_TOP;
    if (m.arch.retVia === 'stack') {
      sp -= m.W;
      rawWrite(m, sp, m.W * 8, SENTINEL);
    } else {
      m.regs[canon(m, m.arch.lr)] = SENTINEL;
    }
    m.regs[canon(m, m.arch.sp)] = sp;
  }

  /* ---------------- 寄存器 ---------------- */
  function canon(m, n) { return m.alias[n] || n; }
  function rd(m, n, size) {
    var c = canon(m, n);
    var v = m.regs[c];
    if (v === undefined) throw RuntimeError('访问了未知寄存器 ' + n);
    if (size === 32) return u32(v);
    if (size === 8) return uns(v, 8);
    return v;
  }
  function rds(m, n, size) { return sgn(rd(m, n, size), size); }
  function wr(m, n, val, size) {
    var c = canon(m, n);
    var old = m.regs[c];
    var nv = (size === 32 || size === 8) ? u32(val) : val;
    m.regs[c] = nv;
    if (m.ef && old !== nv) m.ef.regs.push({ name: c, old: old, val: nv });
  }

  /* ---------------- 内存 ---------------- */
  function checkAddr(m, addr, bytes) {
    if (addr < 0 || addr + bytes > MEM.SIZE)
      throw RuntimeError('内存访问越界：地址 0x' + (addr >>> 0).toString(16));
  }
  function rawWrite(m, addr, size, val) {
    var bytes = size / 8;
    checkAddr(m, addr, bytes);
    var v = uns(val, size === 64 ? 64 : size);
    for (var i = 0; i < bytes; i++) {
      m.mem[addr + i] = Math.floor(v / Math.pow(2, 8 * i)) & 0xff;
    }
  }
  function rawRead(m, addr, size, signed) {
    var bytes = size / 8;
    checkAddr(m, addr, bytes);
    var v = 0;
    for (var i = 0; i < bytes; i++) v += m.mem[addr + i] * Math.pow(2, 8 * i);
    if (signed) {
      if (size === 32 && v >= 2147483648) v -= TWO32;
      if (size === 8 && v >= 128) v -= 256;
    }
    return v;
  }
  function memWrite(m, addr, size, val) {
    var old = rawRead(m, addr, size, false);
    rawWrite(m, addr, size, val);
    if (m.ef) {
      m.ef.mem.push({ addr: addr, size: size, old: old, val: uns(val, size) });
      m.ef.memOp = { rw: 'W', addr: addr, size: size, val: uns(val, size) };
    }
  }
  function memRead(m, addr, size, signed) {
    var v = rawRead(m, addr, size, signed);
    if (m.ef) m.ef.memOp = { rw: 'R', addr: addr, size: size, val: v };
    return v;
  }

  /* ---------------- 标志位 ---------------- */
  function setFlagsSub(m, a, b, size) {
    var sa = sgn(a, size), sb = sgn(b, size);
    var raw = sa - sb;
    var res = size === 64 ? raw : sgn(raw, size);
    m.flags = {
      N: res < 0,
      Z: res === 0,
      C: uns(a, size) >= uns(b, size),
      V: ((sa < 0) !== (sb < 0)) && ((res < 0) !== (sa < 0))
    };
    if (m.ef) m.ef.flags = true;
  }
  function testCond(m, cond) {
    var f = m.flags;
    switch (cond) {
      case 'eq': return f.Z;
      case 'ne': return !f.Z;
      case 'lt': return f.N !== f.V;
      case 'ge': return f.N === f.V;
      case 'le': return f.Z || (f.N !== f.V);
      case 'gt': return !f.Z && (f.N === f.V);
    }
    throw RuntimeError('未知条件码 ' + cond);
  }

  /* ---------------- ALU ---------------- */
  function alu(m, o, a, b, size) {
    var sa = sgn(a, size), sb = sgn(b, size);
    switch (o) {
      case 'add': return size === 32 ? (sa + sb) | 0 : sa + sb;
      case 'sub': return size === 32 ? (sa - sb) | 0 : sa - sb;
      case 'mul': return size === 32 ? Math.imul(sa, sb) : sa * sb;
      case 'div':
        if (sb === 0) throw RuntimeError('除以零');
        return Math.trunc(sa / sb);
      case 'mod':
        if (sb === 0) throw RuntimeError('除以零（取模）');
        return sa % sb;
      case 'and': return size === 32 ? (sa & sb) : (sa & sb);
      case 'or':  return (sa | sb);
      case 'xor': return (sa ^ sb);
      case 'shl': return size === 32 ? (sa << (sb & 31)) | 0 : sa * Math.pow(2, sb & 63);
      case 'sar': return size === 32 ? (sa >> (sb & 31)) : Math.floor(sa / Math.pow(2, sb & 63));
      case 'neg': return size === 32 ? (-sa) | 0 : -sa;
      case 'not': return size === 32 ? (~sa) | 0 : -sa - 1;
      case 'sext32': return sgn(a, 32);
    }
    throw RuntimeError('未知 ALU 操作 ' + o);
  }

  var STAGES = {
    label: ['IF'], dir: ['IF'], nop: ['IF', 'ID'],
    imm: ['IF', 'ID', 'WB'], mov: ['IF', 'ID', 'WB'],
    lea: ['IF', 'ID', 'EX', 'WB'], lo12: ['IF', 'ID', 'EX', 'WB'],
    ldr: ['IF', 'ID', 'EX', 'MEM', 'WB'], str: ['IF', 'ID', 'EX', 'MEM'],
    alu: ['IF', 'ID', 'EX', 'WB'], idiv: ['IF', 'ID', 'EX', 'WB'], msub: ['IF', 'ID', 'EX', 'WB'],
    cmp: ['IF', 'ID', 'EX'], set: ['IF', 'ID', 'EX', 'WB'], movcc: ['IF', 'ID', 'EX', 'WB'],
    jmp: ['IF', 'ID', 'EX'], br: ['IF', 'ID', 'EX'], brz: ['IF', 'ID', 'EX'],
    call: ['IF', 'ID', 'EX', 'MEM'], ret: ['IF', 'ID', 'EX', 'MEM'],
    push: ['IF', 'ID', 'EX', 'MEM'], pop: ['IF', 'ID', 'EX', 'MEM', 'WB'],
    pushm: ['IF', 'ID', 'EX', 'MEM'], popm: ['IF', 'ID', 'EX', 'MEM', 'WB'],
    stp: ['IF', 'ID', 'EX', 'MEM'], ldp: ['IF', 'ID', 'EX', 'MEM', 'WB']
  };

  /* ---------------- 内建输出函数 ---------------- */
  function builtinArg(m, i) {
    if (m.arch.argOrder === 'rtl') return memRead(m, rd(m, m.arch.sp, m.W * 8) + i * 4, 32, true);
    return rd(m, m.arch.argRegs[i], 32);
  }
  function builtinArgPtr(m, i) {
    if (m.arch.argOrder === 'rtl') return memRead(m, rd(m, m.arch.sp, m.W * 8) + i * 4, 32, false);
    return rd(m, m.arch.argRegs[i], m.W * 8);
  }
  function runBuiltin(m, name) {
    var s = '';
    if (name === '__print_int') s = String(sgn(builtinArg(m, 0), 32));
    else if (name === '__print_char') s = String.fromCharCode(builtinArg(m, 0) & 0xff);
    else if (name === '__print_nl') s = '\n';
    else if (name === '__print_str') {
      var p = builtinArgPtr(m, 0), n = 0;
      while (n < 4096) {
        var c = rawRead(m, p + n, 8, false);
        if (!c) break;
        s += String.fromCharCode(c); n++;
      }
    } else throw RuntimeError('调用了未定义的函数 ' + name);
    m.output += s;
    if (m.ef) { m.ef.out = s; m.ef.builtin = name; }
    wr(m, m.arch.family === 'x86' ? (m.W === 8 ? 'eax' : 'eax') : (m.W === 8 ? 'w0' : 'r0'), 0, 32);
  }

  /* ---------------- 单步执行 ---------------- */
  function step(m) {
    if (m.halted) return null;
    if (m.count > MAX_STEPS) { m.halted = true; m.error = '执行步数超过上限（可能是死循环）'; return null; }
    var ins = m.instrs[m.pc];
    if (!ins) { m.halted = true; m.error = 'PC 越界，程序异常终止'; return null; }

    var ef = { instr: ins, pc: m.pc, regs: [], mem: [], flags: false, out: '',
               stages: STAGES[ins.kind] || ['IF', 'ID'], alu: null, memOp: null,
               branch: null, call: null, ret: null };
    m.ef = ef;
    var next = m.pc + 1;
    var A = m.arch, W = m.W, WB = W * 8;

    try {
      switch (ins.kind) {
        case 'label': case 'dir': case 'nop': break;

        case 'imm': wr(m, ins.dst, ins.val, ins.size); break;
        case 'mov': wr(m, ins.dst, rd(m, ins.src, ins.size), ins.size); break;

        case 'lea': {
          var base = ins.base ? rd(m, ins.base, WB) : 0;
          var symv = 0;
          if (ins.sym) {
            if (!(ins.sym in m.symbols)) throw RuntimeError('未知符号 ' + ins.sym);
            symv = m.symbols[ins.sym];
            if (ins.page) symv = symv & ~0xfff;
          }
          var addr = base + (ins.disp || 0) + symv;
          ef.alu = { op: '+', a: base || symv, b: (ins.disp || 0), r: addr, note: '地址计算' };
          wr(m, ins.dst, addr, ins.size);
          break;
        }
        case 'lo12': {
          var lo = m.symbols[ins.sym] & 0xfff;
          var v0 = rd(m, ins.a, ins.size);
          ef.alu = { op: '+', a: v0, b: lo, r: v0 + lo, note: ':lo12:' };
          wr(m, ins.dst, v0 + lo, ins.size);
          break;
        }

        case 'ldr': {
          var ba = rd(m, ins.base, WB);
          var ea = ins.mode === 'post' ? ba : ba + (ins.disp || 0);
          var val = memRead(m, ea, ins.size, !!ins.signed);
          wr(m, ins.dst, val, ins.size);
          if (ins.mode === 'pre') wr(m, ins.base, ba + ins.disp, WB);
          if (ins.mode === 'post') wr(m, ins.base, ba + ins.disp, WB);
          break;
        }
        case 'str': {
          var ba2 = rd(m, ins.base, WB);
          var ea2 = ins.mode === 'post' ? ba2 : ba2 + (ins.disp || 0);
          if (ins.mode === 'pre') { ea2 = ba2 + ins.disp; wr(m, ins.base, ea2, WB); }
          memWrite(m, ea2, ins.size, rd(m, ins.src, ins.size));
          if (ins.mode === 'post') wr(m, ins.base, ba2 + ins.disp, WB);
          break;
        }

        case 'alu': {
          var a1 = rd(m, ins.a, ins.size);
          var b1 = (ins.imm !== undefined) ? ins.imm : (ins.b !== undefined ? rd(m, ins.b, ins.b === 'cl' ? 8 : ins.size) : 0);
          var r1 = alu(m, ins.o, a1, b1, ins.size);
          ef.alu = { op: ins.o, a: sgn(a1, ins.size), b: (ins.o === 'neg' || ins.o === 'not' || ins.o === 'sext32') ? null : sgn(b1, ins.size), r: sgn(r1, ins.size) };
          wr(m, ins.dst, r1, ins.size);
          break;
        }
        case 'idiv': {
          var dividend = rds(m, ins.size === 64 ? 'rax' : 'eax', ins.size);
          var divisor = rds(m, ins.src, ins.size);
          if (divisor === 0) throw RuntimeError('除以零');
          var q = Math.trunc(dividend / divisor), rr = dividend % divisor;
          ef.alu = { op: 'idiv', a: dividend, b: divisor, r: q, note: '商/余数' };
          wr(m, ins.size === 64 ? 'rax' : 'eax', q, ins.size);
          wr(m, ins.size === 64 ? 'rdx' : 'edx', rr, ins.size);
          break;
        }
        case 'msub': {
          var mm1 = rds(m, ins.m1, ins.size), mm2 = rds(m, ins.m2, ins.size), sb2 = rds(m, ins.sub, ins.size);
          var rv = ins.size === 32 ? (sb2 - Math.imul(mm1, mm2)) | 0 : sb2 - mm1 * mm2;
          ef.alu = { op: 'msub', a: sb2, b: mm1 * mm2, r: rv, note: '取余' };
          wr(m, ins.dst, rv, ins.size);
          break;
        }

        case 'cmp': {
          var ca = rd(m, ins.a, ins.size);
          var cb = (ins.imm !== undefined) ? ins.imm : rd(m, ins.b, ins.size);
          setFlagsSub(m, ca, cb, ins.size);
          ef.alu = { op: 'cmp', a: sgn(ca, ins.size), b: sgn(cb, ins.size), r: sgn(ca, ins.size) - sgn(cb, ins.size), note: '只置标志位' };
          break;
        }
        case 'set': wr(m, ins.dst, testCond(m, ins.cond) ? 1 : 0, 32); break;
        case 'movcc': if (testCond(m, ins.cond)) wr(m, ins.dst, ins.val, ins.size); break;

        case 'jmp': next = m.labels[ins.label]; ef.branch = { taken: true, to: ins.label }; break;
        case 'br': {
          var tk = testCond(m, ins.cond);
          ef.branch = { taken: tk, to: ins.label, cond: ins.cond };
          if (tk) next = m.labels[ins.label];
          break;
        }
        case 'brz': {
          var zv = rd(m, ins.reg, ins.size) === 0;
          ef.branch = { taken: zv, to: ins.label, cond: 'reg==0' };
          if (zv) next = m.labels[ins.label];
          break;
        }

        case 'call': {
          var tgt = ins.target;
          if (!(tgt in m.labels)) { runBuiltin(m, tgt); break; }
          var retAddr = MEM.CODE_BASE + (m.pc + 1) * 4;
          if (A.retVia === 'stack') {
            var nsp = rd(m, A.sp, WB) - W;
            wr(m, A.sp, nsp, WB);
            memWrite(m, nsp, WB, retAddr);
          } else {
            wr(m, A.lr, retAddr, WB);
          }
          m.callStack.push({ name: tgt, retIdx: m.pc + 1, sp: rd(m, A.sp, WB), line: ins.line });
          ef.call = tgt;
          next = m.labels[tgt];
          break;
        }
        case 'ret': {
          var ra;
          if (A.retVia === 'stack') {
            var sp0 = rd(m, A.sp, WB);
            ra = memRead(m, sp0, WB, false);
            wr(m, A.sp, sp0 + W, WB);
          } else {
            ra = rd(m, A.lr, WB);
          }
          if (ra === SENTINEL) {
            m.halted = true;
            m.exitCode = sgn(rd(m, A.family === 'x86' ? 'eax' : (A.bits === 64 ? 'w0' : 'r0'), 32), 32);
            ef.ret = 'exit';
            m.ef = ef;
            m.count++;
            return ef;
          }
          if (m.callStack.length > 1) m.callStack.pop();
          ef.ret = 'return';
          next = (ra - MEM.CODE_BASE) / 4;
          if (next !== Math.floor(next) || next < 0 || next >= m.instrs.length)
            throw RuntimeError('返回地址非法：0x' + ra.toString(16));
          break;
        }

        case 'push': {
          var s1 = rd(m, A.sp, WB) - W;
          wr(m, A.sp, s1, WB);
          memWrite(m, s1, WB, rd(m, ins.src, WB));
          break;
        }
        case 'pop': {
          var s2 = rd(m, A.sp, WB);
          wr(m, ins.dst, memRead(m, s2, WB, false), WB);
          wr(m, A.sp, s2 + W, WB);
          break;
        }
        case 'pushm': {
          var n1 = ins.regs.length;
          var s3 = rd(m, A.sp, WB) - n1 * W;
          wr(m, A.sp, s3, WB);
          for (var i1 = 0; i1 < n1; i1++) memWrite(m, s3 + i1 * W, WB, rd(m, ins.regs[i1], WB));
          break;
        }
        case 'popm': {
          var s4 = rd(m, A.sp, WB);
          for (var i2 = 0; i2 < ins.regs.length; i2++) wr(m, ins.regs[i2], memRead(m, s4 + i2 * W, WB, false), WB);
          wr(m, A.sp, s4 + ins.regs.length * W, WB);
          break;
        }
        case 'stp': {
          var b3 = rd(m, ins.base, WB);
          var e3 = ins.mode === 'post' ? b3 : b3 + ins.disp;
          memWrite(m, e3, WB, rd(m, ins.r1, WB));
          memWrite(m, e3 + W, WB, rd(m, ins.r2, WB));
          if (ins.mode === 'pre' || ins.mode === 'post') wr(m, ins.base, b3 + ins.disp, WB);
          break;
        }
        case 'ldp': {
          var b4 = rd(m, ins.base, WB);
          var e4 = ins.mode === 'post' ? b4 : b4 + ins.disp;
          wr(m, ins.r1, memRead(m, e4, WB, false), WB);
          wr(m, ins.r2, memRead(m, e4 + W, WB, false), WB);
          if (ins.mode === 'pre' || ins.mode === 'post') wr(m, ins.base, b4 + ins.disp, WB);
          break;
        }

        default:
          throw RuntimeError('模拟器不支持的指令类型 ' + ins.kind);
      }
    } catch (e) {
      m.halted = true;
      m.error = (e.isRuntime ? '' : '内部错误：') + e.message + '（' + ins.text + '）';
      return ef;
    }

    var spv = rd(m, A.sp, WB);
    if (spv < m.prog.dataEnd) { m.halted = true; m.error = '栈溢出（递归过深？）'; return ef; }
    if (spv < m.maxSp) m.maxSp = spv;

    m.pc = next;
    m.count++;
    wr(m, A.pcName, MEM.CODE_BASE + m.pc * 4, WB);
    if (m.ef) m.ef.regs = m.ef.regs.filter(function (r) { return r.name !== A.pcName; });
    return ef;
  }

  function run(m, maxSteps, breakpoints) {
    var n = 0;
    while (!m.halted && n < maxSteps) {
      step(m); n++;
      if (breakpoints && breakpoints.has(m.pc) && !m.halted) return { hitBreak: true, steps: n };
    }
    return { hitBreak: false, steps: n };
  }

  /* ---------------- 显示辅助 ---------------- */
  function hex(v, bits) {
    var s;
    if (bits === 64) s = BigInt.asUintN(64, BigInt(Math.trunc(v))).toString(16);
    else s = u32(v).toString(16);
    while (s.length < bits / 4) s = '0' + s;
    return '0x' + s;
  }

  CE.Machine = { create: create, reset: reset, step: step, run: run, hex: hex,
                 rd: rd, wr: wr, memRead: rawRead, u32: u32, sgn: sgn, SENTINEL: SENTINEL };
})(typeof window !== 'undefined' ? window : globalThis);

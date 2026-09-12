/* ============================================================
 * CPU-EYE  CPU 结构示意图
 * 一张完整的处理器框图：PC、指令存储器、指令寄存器、译码器、
 * 控制单元、寄存器堆、ALU、标志寄存器、数据存储器、写回通路，
 * 以及地址总线 / 数据总线 / 控制总线。
 * 每执行一条指令，参与工作的部件与总线会点亮，总线上显示实时的
 * 地址与数据，底部的内存映射会标出当前访问的位置。
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});
  var NS = 'http://www.w3.org/2000/svg';
  var MEM = CE.MEM;

  /* ---------------- SVG 小工具 ---------------- */
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, cls, anchor) {
    var t = el('text', { x: x, y: y, class: cls || 'blk-v', 'text-anchor': anchor || 'middle' }, parent);
    t.textContent = s || '';
    return t;
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function sh(v) { return '0x' + (v >>> 0).toString(16); }     // 短十六进制，给内存映射用

  /* ---------------- 部件 ---------------- */
  var BLOCKS = [
    { id: 'cu',    x: 322,  y: 10,  w: 556, h: 58,  t: '控制单元 CU' },
    { id: 'pc',    x: 16,   y: 148, w: 104, h: 56,  t: 'PC 程序计数器' },
    { id: 'add',   x: 16,   y: 252, w: 104, h: 44,  t: '地址加法器' },
    { id: 'imem',  x: 196,  y: 132, w: 132, h: 100, t: '指令存储器' },
    { id: 'ir',    x: 400,  y: 132, w: 190, h: 56,  t: 'IR 指令寄存器' },
    { id: 'dec',   x: 400,  y: 200, w: 190, h: 56,  t: '指令译码器' },
    { id: 'rf',    x: 640,  y: 116, w: 196, h: 158, t: '寄存器堆' },
    { id: 'dmem',  x: 1064, y: 126, w: 124, h: 112, t: '数据存储器' },
    { id: 'flags', x: 640,  y: 310, w: 170, h: 44,  t: '标志寄存器' },
    { id: 'mux',   x: 856,  y: 310, w: 150, h: 44,  t: '写回选择 MUX' }
  ];
  var ALU_PTS = '856,126 1000,168 1000,212 856,254 856,204 836,190 856,176';

  /* ---------------- 总线 ----------------
   * p: 折线顶点；lx/ly: 名称位置；vy: 数值位置（不给则在名称下方）
   * ctrl: 控制线（虚线、紫色）；noval: 只显示名称不显示数值
   */
  var BUSES = [
    { id: 'pc_imem',   p: [[120,176],[196,176]],                               n: '地址',     lx: 158, ly: 166, vy: 194 },
    { id: 'pc_add',    p: [[68,204],[68,252]] },
    { id: 'add_pc',    p: [[16,274],[6,274],[6,176],[16,176]] },
    { id: 'imem_ir',   p: [[328,156],[400,156]],                               n: '指令',     lx: 364, ly: 146, vy: 174 },
    { id: 'ir_dec',    p: [[495,188],[495,200]] },
    { id: 'dec_cu',    p: [[590,230],[614,230],[614,96],[660,96],[660,68]],    n: '操作码',   lx: 552, ly: 102, vy: 122 },
    { id: 'cu_rf',     p: [[760,68],[760,116]], ctrl: 1 },
    { id: 'cu_alu',    p: [[900,68],[900,112],[920,112],[920,144]], ctrl: 1 },
    { id: 'cu_pc',     p: [[340,39],[150,39],[150,162],[120,162]],             n: '跳转地址', lx: 246, ly: 30,  vy: 58 },
    { id: 'rf_alu_a',  p: [[836,150],[856,150]],                               n: 'A', lx: 846, ly: 140, noval: 1 },
    { id: 'rf_alu_b',  p: [[836,230],[856,230]],                               n: 'B', lx: 846, ly: 248, noval: 1 },
    { id: 'alu_flags', p: [[880,247],[880,290],[725,290],[725,310]],           n: '标志',     lx: 800, ly: 283, vy: 304 },
    { id: 'flags_cu',  p: [[640,322],[380,322],[380,80],[740,80],[740,68]],    n: '条件',     lx: 356, ly: 196, vy: 214 },
    { id: 'alu_dmem',  p: [[1000,180],[1064,180]],                             n: '地址',     lx: 1032, ly: 170, vy: 198 },
    { id: 'rf_dmem',   p: [[836,262],[1035,262],[1035,220],[1064,220]],        n: '写入数据', lx: 930, ly: 254, vy: 278 },
    { id: 'alu_mux',   p: [[960,228],[960,310]] },
    { id: 'dmem_mux',  p: [[1100,238],[1100,332],[1006,332]],                  n: '读出数据', lx: 1112, ly: 270, vy: 286 },
    { id: 'mux_rf',    p: [[930,354],[930,382],[620,382],[620,290],[700,290],[700,274]], n: '写回', lx: 790, ly: 375, vy: 395 }
  ];

  var STAGE_BLOCKS = { IF: ['pc', 'imem', 'add'], ID: ['ir', 'dec', 'cu'], EX: ['alu', 'rf'], MEM: ['dmem'], WB: ['mux', 'rf'] };

  var KIND_CN = {
    imm: '立即数装载', mov: '寄存器传送', lea: '地址计算', lo12: '地址低位拼接',
    ldr: '内存读取', str: '内存写入', alu: '算术/逻辑运算', idiv: '整数除法',
    msub: '乘减（求余）', cmp: '比较并置标志位', set: '条件置位', movcc: '条件传送',
    jmp: '无条件跳转', br: '条件跳转', brz: '为零则跳转', call: '函数调用', ret: '函数返回',
    push: '压栈', pop: '出栈', pushm: '多寄存器压栈', popm: '多寄存器出栈',
    stp: '寄存器对存储', ldp: '寄存器对加载', label: '标号', dir: '伪指令', nop: '辅助指令'
  };
  var SIGNALS = ['RegWrite', 'ALUSrc', 'MemRead', 'MemWrite', 'Branch', 'MemToReg'];

  /* 内存映射区的纵向坐标 */
  var M = { codeTitle: 418, codeBar: 426, barH: 26, codeEnd: 468, codeMark: 484,
            dataTitle: 508, dataBar: 516, dataSeg: 556, dataMark: 574 };

  var S = { svg: null, blocks: {}, buses: {}, vals: {}, sig: {}, map: {}, rfCells: [], built: false };

  /* ---------------- 构建 ---------------- */
  function build(container) {
    container.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 1200 600', preserveAspectRatio: 'xMidYMid meet', id: 'schemSvg' }, container);
    S.svg = svg;
    var defs = el('defs', {}, svg);
    var mk = el('marker', { id: 'sah', markerWidth: 9, markerHeight: 9, refX: 8, refY: 4.5, orient: 'auto' }, defs);
    el('path', { d: 'M0,0 L9,4.5 L0,9 z', fill: 'currentColor' }, mk);

    var gBus = el('g', {}, svg);
    var gPlate = el('g', {}, svg);
    var gBlk = el('g', {}, svg);

    BUSES.forEach(function (b) {
      var d = 'M' + b.p.map(function (q) { return q[0] + ',' + q[1]; }).join(' L');
      var path = el('path', { d: d, class: 'bus' + (b.ctrl ? ' ctrl' : ''), 'marker-end': 'url(#sah)' }, gBus);
      var o = { path: path, def: b };
      if (b.n) o.label = txt(gBus, b.lx, b.ly, b.n, 'bus-label');
      if (b.n && !b.noval) {
        o.plate = el('rect', { x: 0, y: 0, width: 0, height: 15, rx: 3, class: 'bus-plate' }, gPlate);
        o.val = txt(gPlate, b.lx, b.vy, '', 'bus-val');
      }
      S.buses[b.id] = o;
    });

    BLOCKS.forEach(function (b) {
      var gp = el('g', { class: 'blk', id: 'sb-' + b.id }, gBlk);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 7 }, gp);
      txt(gp, b.x + b.w / 2, b.y + 18, b.t, 'blk-t');
      S.blocks[b.id] = gp;
      S.vals[b.id] = [
        txt(gp, b.x + b.w / 2, b.y + 36, '', 'blk-v'),
        txt(gp, b.x + b.w / 2, b.y + 51, '', 'blk-v2')
      ];
    });

    var galu = el('g', { class: 'blk', id: 'sb-alu' }, gBlk);
    el('polygon', { points: ALU_PTS }, galu);
    txt(galu, 928, 160, 'ALU', 'blk-t');
    S.blocks.alu = galu;
    S.vals.alu = [txt(galu, 928, 182, '', 'blk-v'), txt(galu, 928, 200, '', 'blk-v2'), txt(galu, 928, 222, '', 'blk-v2')];

    var gs = el('g', {}, S.blocks.cu);
    SIGNALS.forEach(function (name, i) {
      var x = 336 + i * 91, y = 38;
      S.sig[name] = {
        rect: el('rect', { x: x, y: y, width: 84, height: 20, rx: 4, class: 'sig' }, gs),
        text: txt(gs, x + 42, y + 14, name, 'sig-t')
      };
    });

    var rfg = el('g', {}, S.blocks.rf);
    S.rfCells = [];
    for (var i = 0; i < 12; i++) {
      var col = i % 2, row = Math.floor(i / 2);
      var x = 648 + col * 98, y = 140 + row * 22;
      S.rfCells.push({
        rect: el('rect', { x: x, y: y, width: 88, height: 19, rx: 3, class: 'rfc' }, rfg),
        n: txt(rfg, x + 4, y + 13.5, '', 'rfc-n', 'start'),
        v: txt(rfg, x + 84, y + 13.5, '', 'rfc-v', 'end')
      });
    }

    buildMemMap(svg);
    S.built = true;
    return svg;
  }

  function buildMemMap(svg) {
    var gm = el('g', {}, svg);
    txt(gm, 20, M.codeTitle, '代码空间 · 指令按 4 字节等距排列', 'map-title', 'start');
    el('rect', { x: 20, y: M.codeBar, width: 1164, height: M.barH, rx: 4, class: 'mapbar' }, gm);
    S.map.codeFns = el('g', {}, gm);
    S.map.codeMark = el('polygon', { points: '0,0 -6,-10 6,-10', class: 'mark pc' }, gm);
    S.map.codeL = txt(gm, 20, M.codeEnd, '', 'map-end', 'start');
    S.map.codeR = txt(gm, 1184, M.codeEnd, '', 'map-end', 'end');
    S.map.codeMarkT = txt(gm, 0, M.codeMark, '', 'mark-t');

    txt(gm, 20, M.dataTitle, '数据空间 · 64 KiB 平坦内存（按比例示意）', 'map-title', 'start');
    S.map.segs = [];
    ['保留', '数据段（全局变量）', '未使用', '栈段', '保留'].forEach(function (n, i) {
      S.map.segs.push({
        rect: el('rect', { x: 0, y: M.dataBar, width: 0, height: M.barH, rx: 4, class: 'mapseg s' + i }, gm),
        t: txt(gm, 0, M.dataBar + 17, n, 'mapseg-t'),
        a: txt(gm, 0, M.dataSeg, '', 'map-end')
      });
    });
    S.map.spMark = el('polygon', { points: '0,0 -6,-10 6,-10', class: 'mark sp' }, gm);
    S.map.dataMark = el('polygon', { points: '0,0 -6,-10 6,-10', class: 'mark data' }, gm);
    S.map.dataMarkT = txt(gm, 0, M.dataMark, '', 'mark-t');
  }

  /* ---------------- 更新 ---------------- */
  function shortVal(v, bits) {
    if (v === undefined || v === null) return '';
    if (v >= -99999 && v <= 99999) return String(v);
    return CE.Machine.hex(v, (v > 0xffffffff || v < 0) ? bits : 32);
  }
  function setVals(id, a, b, c) {
    var arr = S.vals[id];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) arr[i].textContent = [a, b, c][i] == null ? '' : [a, b, c][i];
  }
  function on(id, yes) { var b = S.blocks[id]; if (b) b.classList.toggle('on', !!yes); }
  function busOn(id, yes, val) {
    var b = S.buses[id];
    if (!b) return;
    b.path.classList.toggle('on', !!yes);
    if (b.label) b.label.classList.toggle('on', !!yes);
    if (b.val) {
      var s = (yes && val != null && val !== true) ? String(val) : '';
      b.val.textContent = s;
      var w = s ? s.length * 6.5 + 10 : 0;
      b.plate.setAttribute('x', b.def.lx - w / 2);
      b.plate.setAttribute('y', b.def.vy - 11);
      b.plate.setAttribute('width', w);
    }
  }

  function activeBuses(m, ef) {
    var k = ef.instr.kind, a = {}, hex = CE.Machine.hex;
    a.pc_imem = hex(ef.instr.addr, 32);
    a.imem_ir = clip(ef.instr.text.trim().split(/\s+/)[0], 9);
    a.ir_dec = true;
    a.dec_cu = KIND_CN[k] || k;
    a.pc_add = true;
    if (ef.alu) {
      a.rf_alu_a = true;
      if (ef.alu.b !== null && ef.alu.b !== undefined) a.rf_alu_b = true;
    }
    if (ef.flags) a.alu_flags = 'NZCV';
    if (k === 'br' || k === 'brz') {
      a.flags_cu = ef.branch ? (ef.branch.taken ? '成立' : '不成立') : '';
      if (ef.branch && ef.branch.taken) a.cu_pc = clip(ef.branch.to, 14);
    }
    if (k === 'jmp') a.cu_pc = ef.branch ? clip(ef.branch.to, 14) : true;
    if (k === 'call') a.cu_pc = clip(ef.call || '', 14);
    if (k === 'ret') a.cu_pc = '返回地址';
    if (ef.memOp) {
      a.alu_dmem = hex(ef.memOp.addr, 32);
      if (ef.memOp.rw === 'R') a.dmem_mux = shortVal(ef.memOp.val, m.arch.bits);
      else a.rf_dmem = shortVal(ef.memOp.val, m.arch.bits);
    }
    if (ef.regs && ef.regs.length) {
      var last = ef.regs[ef.regs.length - 1];
      a.alu_mux = true;
      a.mux_rf = last.name + ' ← ' + shortVal(last.val, m.arch.bits);
    }
    return a;
  }

  function signalsFor(ef) {
    var k = ef.instr.kind;
    return {
      RegWrite: !!(ef.regs && ef.regs.length),
      ALUSrc: !!(ef.instr.imm !== undefined || k === 'lea' || k === 'ldr' || k === 'str'),
      MemRead: !!(ef.memOp && ef.memOp.rw === 'R'),
      MemWrite: !!(ef.memOp && ef.memOp.rw === 'W'),
      Branch: (k === 'br' || k === 'brz' || k === 'jmp' || k === 'call' || k === 'ret'),
      MemToReg: !!(ef.memOp && ef.memOp.rw === 'R' && ef.regs && ef.regs.length)
    };
  }

  function update(m, ef, prog) {
    if (!S.built || !m) return;
    var hex = CE.Machine.hex, arch = m.arch;

    Object.keys(S.blocks).forEach(function (id) { on(id, false); });
    Object.keys(S.buses).forEach(function (id) { busOn(id, false); });
    SIGNALS.forEach(function (n) { S.sig[n].rect.classList.remove('on'); S.sig[n].text.classList.remove('on'); });

    setVals('pc', hex(MEM.CODE_BASE + m.pc * 4, 32), '第 ' + m.pc + ' 条指令');
    setVals('add', '+4 / 跳转目标');
    setVals('imem', prog.instrs.length + ' 条指令', '起始 ' + hex(MEM.CODE_BASE, 32));
    setVals('dmem', '64 KiB', '数据段 ' + sh(MEM.DATA_BASE));

    var regs = arch.regs.slice(0, 12);
    var written = {}, read = {};
    if (ef && ef.regs) ef.regs.forEach(function (r) { written[r.name] = 1; });
    if (ef && ef.instr) ['a', 'b', 'src', 'base', 'r1', 'r2', 'm1', 'm2'].forEach(function (kk) {
      var v = ef.instr[kk];
      if (typeof v === 'string') read[(arch.alias && arch.alias[v]) || v] = 1;
    });
    S.rfCells.forEach(function (c, i) {
      var name = regs[i];
      c.n.textContent = name || '';
      c.v.textContent = name ? shortVal(m.regs[name] || 0, arch.bits) : '';
      c.rect.setAttribute('class', 'rfc' + (!name ? '' : written[name] ? ' w' : read[name] ? ' r' : ''));
    });

    var f = m.flags;
    setVals('flags',
      arch.flagStyle === 'x86'
        ? 'ZF=' + (+f.Z) + '  SF=' + (+f.N) + '  CF=' + (+f.C) + '  OF=' + (+f.V)
        : 'N=' + (+f.N) + '  Z=' + (+f.Z) + '  C=' + (+f.C) + '  V=' + (+f.V),
      arch.flagStyle === 'x86' ? 'EFLAGS' : 'NZCV (CPSR)');

    if (!ef || !ef.instr) {
      setVals('ir', m.halted ? '程序已结束' : '等待执行…');
      setVals('dec'); setVals('cu'); setVals('mux'); setVals('alu');
      on('pc', true);
      updateMap(m, null, prog);
      return;
    }

    var ins = ef.instr;
    setVals('ir', clip(ins.text.replace(/\s+/g, ' '), 24), ins.line ? 'C++ 第 ' + ins.line + ' 行' : '');
    setVals('dec', KIND_CN[ins.kind] || ins.kind, ins.fn ? '位于 ' + ins.fn + '()' : '');
    if (ef.alu) {
      var A = ef.alu;
      setVals('alu', A.op, (A.b === null || A.b === undefined) ? String(A.a) : A.a + ' , ' + A.b, '= ' + A.r);
    } else setVals('alu', '—', '本条指令不做运算');
    if (ef.memOp && ef.memOp.rw === 'R') setVals('mux', '选择：内存读出的数据');
    else if (ef.regs && ef.regs.length) setVals('mux', '选择：ALU 结果');
    else setVals('mux', '—');

    (ef.stages || []).forEach(function (st) {
      (STAGE_BLOCKS[st] || []).forEach(function (b) { on(b, true); });
    });
    on('cu', true);
    if (ef.flags) on('flags', true);

    var act = activeBuses(m, ef);
    Object.keys(act).forEach(function (id) { busOn(id, true, act[id]); });

    var sg = signalsFor(ef);
    SIGNALS.forEach(function (n) {
      if (sg[n]) { S.sig[n].rect.classList.add('on'); S.sig[n].text.classList.add('on'); }
    });

    updateMap(m, ef, prog);
  }

  /* ---------------- 内存映射 ---------------- */
  function updateMap(m, ef, prog) {
    var hex = CE.Machine.hex, X0 = 20, W = 1164;
    var n = prog.instrs.length;
    var pcx = X0 + (m.pc / Math.max(1, n)) * W;
    S.map.codeMark.setAttribute('transform', 'translate(' + pcx.toFixed(1) + ',' + M.codeBar + ')');
    S.map.codeMarkT.setAttribute('x', Math.min(X0 + W - 70, Math.max(X0 + 70, pcx)));
    S.map.codeMarkT.textContent = 'PC = ' + hex(MEM.CODE_BASE + m.pc * 4, 32) + '（第 ' + m.pc + ' 条）';
    S.map.codeL.textContent = hex(MEM.CODE_BASE, 32);
    S.map.codeR.textContent = hex(MEM.CODE_BASE + n * 4, 32);

    if (S.map.fnProg !== prog) {
      while (S.map.codeFns.firstChild) S.map.codeFns.removeChild(S.map.codeFns.firstChild);
      Object.keys(prog.frames).forEach(function (fname) {
        var idx = prog.frames[fname].entry;
        if (idx == null) return;
        var x = X0 + (idx / Math.max(1, n)) * W;
        el('line', { x1: x, y1: M.codeBar, x2: x, y2: M.codeBar + M.barH, class: 'fnline' }, S.map.codeFns);
        var t = el('text', { x: x + 3, y: M.codeBar + 17, class: 'fnname', 'text-anchor': 'start' }, S.map.codeFns);
        t.textContent = fname;
      });
      S.map.fnProg = prog;
    }

    var sp = m.regs[(m.arch.alias && m.arch.alias[m.arch.sp]) || m.arch.sp] || MEM.STACK_TOP;
    var segs = [
      { a: 0, b: MEM.DATA_BASE, f: 0.10 },
      { a: MEM.DATA_BASE, b: prog.dataEnd, f: 0.24 },
      { a: prog.dataEnd, b: sp, f: 0.32 },
      { a: sp, b: MEM.STACK_TOP, f: 0.26 },
      { a: MEM.STACK_TOP, b: MEM.SIZE, f: 0.08 }
    ];
    var x = X0;
    segs.forEach(function (s, i) {
      var w = W * s.f, o = S.map.segs[i];
      o.rect.setAttribute('x', x); o.rect.setAttribute('width', Math.max(2, w));
      o.t.setAttribute('x', x + w / 2);
      // 两端的地址标注贴着边缘对齐，避免超出画布被裁掉
      var anchor = i === 0 ? 'start' : i === segs.length - 1 ? 'end' : 'middle';
      o.a.setAttribute('text-anchor', anchor);
      o.a.setAttribute('x', anchor === 'start' ? x : anchor === 'end' ? x + w : x + w / 2);
      o.a.textContent = sh(s.a) + ' – ' + sh(s.b) + '　' + Math.max(0, s.b - s.a) + ' 字节';
      s.x = x; s.w = w;
      x += w;
    });
    S.map.spMark.setAttribute('transform', 'translate(' + segs[3].x.toFixed(1) + ',' + M.dataBar + ')');

    if (ef && ef.memOp) {
      var a = ef.memOp.addr, mx = null;
      for (var i = 0; i < segs.length; i++) {
        if (a >= segs[i].a && a < segs[i].b && segs[i].b > segs[i].a) {
          mx = segs[i].x + (a - segs[i].a) / (segs[i].b - segs[i].a) * segs[i].w;
          break;
        }
      }
      if (mx === null) mx = segs[0].x;
      S.map.dataMark.style.display = '';
      S.map.dataMark.setAttribute('transform', 'translate(' + mx.toFixed(1) + ',' + M.dataBar + ')');
      S.map.dataMarkT.setAttribute('x', Math.min(X0 + W - 110, Math.max(X0 + 110, mx)));
      S.map.dataMarkT.textContent = (ef.memOp.rw === 'R' ? '读 ' : '写 ') + hex(ef.memOp.addr, 32) +
        '　' + ef.memOp.size + ' 位　值 ' + ef.memOp.val;
    } else {
      S.map.dataMark.style.display = 'none';
      S.map.dataMarkT.textContent = '';
    }
  }

  CE.Schematic = { build: build, update: update, isBuilt: function () { return S.built; } };
})(typeof window !== 'undefined' ? window : globalThis);

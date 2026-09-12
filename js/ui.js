/* ============================================================
 * CPU-EYE  界面：编译 / 单步 / 运行 / 可视化
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = g.CE, M = CE.Machine, MEM = CE.MEM;
  var $ = function (id) { return document.getElementById(id); };

  var LH = 20, PAD = 8;
  var SPEEDS = [
    { n: '慢放', iv: 420, batch: 1 },
    { n: '慢速', iv: 150, batch: 1 },
    { n: '中速', iv: 55,  batch: 1 },
    { n: '快速', iv: 16,  batch: 14 },
    { n: '极速', iv: 0,   batch: 1500 }
  ];
  var KIND_CN = {
    imm: '立即数装载', mov: '寄存器传送', lea: '地址计算', lo12: '地址低位拼接',
    ldr: '内存读取', str: '内存写入', alu: '算术/逻辑运算', idiv: '整数除法',
    msub: '乘减(求余)', cmp: '比较·置标志位', set: '条件置位', movcc: '条件传送',
    jmp: '无条件跳转', br: '条件跳转', brz: '为零则跳转', call: '函数调用', ret: '函数返回',
    push: '压栈', pop: '出栈', pushm: '多寄存器压栈', popm: '多寄存器出栈',
    stp: '寄存器对存储', ldp: '寄存器对加载', label: '标号', dir: '伪指令', nop: '辅助指令'
  };
  var DP_BLOCKS = [
    { id: 'pc', t: '取指 PC' }, { id: 'imem', t: '指令存储' }, { id: 'dec', t: '译码' },
    { id: 'rf', t: '寄存器堆' }, { id: 'alu', t: 'ALU' }, { id: 'dmem', t: '数据存储' }, { id: 'wb', t: '写回' }
  ];
  var STAGE_CN = { IF: '取指', ID: '译码', EX: '执行', MEM: '访存', WB: '写回' };
  var STAGE_BLOCKS = { IF: ['pc', 'imem'], ID: ['dec'], EX: ['alu'], MEM: ['dmem'], WB: ['wb', 'rf'] };

  var S = {
    arch: 'x86-64', progIdx: 0, prog: null, m: null,
    running: false, timer: null, speed: 2,
    bps: new Set(), trace: [], memTab: 'stack', dirty: true, lastEf: null
  };

  /* ---------------- 工具 ---------------- */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function hex(v, bits) { return M.hex(v, bits); }
  function pad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

  var REGSET = null;
  function buildRegSet(t) {
    var s = {};
    t.regs.forEach(function (r) { s[r] = 1; });
    Object.keys(t.alias || {}).forEach(function (r) { s[r] = 1; });
    ['sp', 'fp', 'lr', 'pc', 'rip', 'eip'].forEach(function (r) { s[r] = 1; });
    return s;
  }
  function hlAsm(text) {
    var cut = text.search(/;|\/\//);
    var cm = '';
    if (cut >= 0) { cm = text.slice(cut); text = text.slice(0, cut); }
    var out = '', first = true;
    var re = /([A-Za-z_.][A-Za-z0-9_.]*|0x[0-9A-Fa-f]+|\d+|\s+|[\s\S])/g, mres;
    while ((mres = re.exec(text)) !== null) {
      var tk = mres[0];
      if (/^\s+$/.test(tk)) { out += tk; continue; }
      if (first && /^[A-Za-z.]/.test(tk)) { out += '<span class="mn">' + esc(tk) + '</span>'; first = false; continue; }
      if (REGSET && REGSET[tk]) out += '<span class="rg">' + esc(tk) + '</span>';
      else if (/^(0x[0-9A-Fa-f]+|\d+)$/.test(tk)) out += '<span class="nu">' + esc(tk) + '</span>';
      else out += esc(tk);
    }
    if (cm) out += '<span class="cm">' + esc(cm) + '</span>';
    return out;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    // 架构标签
    var tabs = $('archTabs');
    CE.ARCH_IDS.forEach(function (id) {
      var t = CE.makeTarget(id);
      var b = document.createElement('button');
      b.textContent = t.title.split(' ')[0];
      b.title = t.title + ' — ' + t.syntax;
      b.dataset.arch = id;
      b.onclick = function () { S.arch = id; syncArchTabs(); build(); };
      tabs.appendChild(b);
    });
    syncArchTabs();

    // 示例程序
    var sel = $('progSel');
    CE.PROGRAMS.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = i; o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.onchange = function () { loadProgram(+sel.value); };

    // 数据通路
    buildDatapath();

    // 事件
    $('btnBuild').onclick = build;
    $('btnStep').onclick = function () { pause(); doStep(); render(S.lastEf); };
    $('btnRun').onclick = toggleRun;
    $('btnReset').onclick = function () { pause(); if (S.m) { M.reset(S.m); S.trace = []; render(null); } };
    $('speed').oninput = function () {
      S.speed = +this.value;
      $('speedLabel').textContent = SPEEDS[S.speed].n;
      if (S.running) { pause(); startRun(); }
    };
    $('dpToggle').onclick = function () {
      var d = $('datapath');
      d.classList.toggle('collapsed');
      this.textContent = d.classList.contains('collapsed') ? '展开' : '收起';
    };
    $('btnCmp').onclick = runCompare;

    var ta = $('src');
    ta.addEventListener('input', function () { S.dirty = true; renderGutter(); updateStatus(); });
    ta.addEventListener('scroll', function () { $('gutter').scrollTop = ta.scrollTop; positionCurLine(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); insertAtCursor(ta, '    '); }
    });

    document.querySelectorAll('#botTabs .tab').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#botTabs .tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-pane').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        $('tab-' + b.dataset.tab).classList.add('active');
        var big = (b.dataset.tab === 'cmp' || b.dataset.tab === 'help');
        $('bottom').style.height = big ? '54vh' : '188px';
      };
    });
    document.querySelectorAll('#memTabs .tab').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#memTabs .tab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        S.memTab = b.dataset.mem;
        renderMem(null);
      };
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'F10') { e.preventDefault(); pause(); doStep(); render(S.lastEf); }
      else if (e.key === 'F5') { e.preventDefault(); toggleRun(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); build(); }
    });

    loadProgram(0);
  }

  function insertAtCursor(ta, txt) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + txt.length;
    S.dirty = true; renderGutter();
  }
  function syncArchTabs() {
    document.querySelectorAll('#archTabs button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.arch === S.arch);
    });
  }
  function loadProgram(i) {
    S.progIdx = i;
    $('progSel').value = i;
    $('src').value = CE.PROGRAMS[i].code;
    S.bps.clear();
    build();
  }

  /* ---------------- 编译 ---------------- */
  function build() {
    pause();
    var src = $('src').value;
    var diag = $('diag');
    try {
      S.prog = CE.compile(src, S.arch);
      S.m = M.create(S.prog);
      S.dirty = false;
      S.trace = [];
      S.lastEf = null;
      REGSET = buildRegSet(S.prog.target);
      var t = S.prog.target;
      diag.className = 'diag ok';
      var real = S.prog.instrs.filter(function (x) { return x.kind !== 'label' && x.kind !== 'dir'; }).length;
      diag.innerHTML = '✔ 编译成功 —— ' + esc(t.title) + '，' + esc(t.syntax) +
        '；生成 <b>' + real + '</b> 条指令，全局数据 ' + (S.prog.dataEnd - MEM.DATA_BASE) + ' 字节。' +
        (CE.PROGRAMS[S.progIdx].desc ? '<br><span class="muted">' + esc(CE.PROGRAMS[S.progIdx].focus) + '：' + esc(CE.PROGRAMS[S.progIdx].desc) + '</span>' : '');
      $('asmTitle').textContent = '汇编指令 · ' + t.title;
      $('regArch').textContent = t.bits + ' 位 · ' + (t.family === 'x86' ? 'Intel 语法' : 'ARM 语法');
      $('flagHint').textContent = t.flagStyle === 'x86' ? 'EFLAGS' : 'NZCV (CPSR)';
      $('srcInfo').textContent = CE.PROGRAMS[S.progIdx].name + (isEdited() ? ' · 已修改' : '');
      renderGutter();
      renderAsm();
      render(null);
    } catch (e) {
      S.prog = null; S.m = null;
      diag.className = 'diag err';
      diag.innerHTML = '✘ 编译失败' + (e.line ? '（第 ' + e.line + ' 行）' : '') + '：' + esc(e.message);
      $('asmList').innerHTML = '';
      highlightSrcLine(e.line || 0);
      updateStatus();
    }
  }
  function isEdited() { return $('src').value !== CE.PROGRAMS[S.progIdx].code; }
  // 有些示例（如内存布局）在不同架构下预期输出本来就不同
  function expectFor(p, arch) {
    if (p.expectByArch && p.expectByArch[arch] !== undefined) return p.expectByArch[arch];
    return p.expect;
  }

  /* ---------------- 源码区 ---------------- */
  function renderGutter() {
    var n = $('src').value.split('\n').length;
    var gut = $('gutter'), html = '';
    for (var i = 1; i <= n; i++) html += '<div data-l="' + i + '">' + i + '</div>';
    gut.innerHTML = html;
    gut.scrollTop = $('src').scrollTop;
  }
  function highlightSrcLine(line) {
    var bar = $('curLineBar');
    if (!line) { bar.style.display = 'none'; }
    else { bar.style.display = 'block'; bar.dataset.line = line; positionCurLine(); }
    document.querySelectorAll('#gutter div').forEach(function (d) {
      d.classList.toggle('cur', +d.dataset.l === line);
    });
    if (line) {
      var ta = $('src');
      var top = (line - 1) * LH;
      if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 2 * LH) {
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
        $('gutter').scrollTop = ta.scrollTop;
      }
    }
  }
  function positionCurLine() {
    var bar = $('curLineBar');
    if (bar.style.display === 'none') return;
    var line = +bar.dataset.line || 1;
    bar.style.top = ((line - 1) * LH + PAD - $('src').scrollTop) + 'px';
  }

  /* ---------------- 汇编区 ---------------- */
  var asmRows = [];
  function renderAsm() {
    var list = $('asmList');
    list.innerHTML = '';
    asmRows = [];
    var frag = document.createDocumentFragment();
    S.prog.instrs.forEach(function (ins, i) {
      var row = document.createElement('div');
      row.className = 'asm-row' + (ins.kind === 'label' ? ' lab' : '') + (ins.kind === 'dir' ? ' dir' : '');
      var isFnLabel = ins.kind === 'label' && S.prog.frames[ins.name];
      if (isFnLabel) row.className += ' fnstart';
      var bp = document.createElement('span');
      bp.className = 'bp';
      bp.textContent = (ins.kind === 'label' || ins.kind === 'dir') ? '' : hex(ins.addr, 32).slice(4);
      bp.onclick = function (e) {
        e.stopPropagation();
        if (ins.kind === 'label' || ins.kind === 'dir') return;
        if (S.bps.has(i)) S.bps.delete(i); else S.bps.add(i);
        row.classList.toggle('brk', S.bps.has(i));
      };
      var tx = document.createElement('span');
      tx.className = 'tx';
      tx.innerHTML = (ins.kind === 'label' || ins.kind === 'dir' ? '' : '        ') + hlAsm(ins.text);
      row.appendChild(bp); row.appendChild(tx);
      row.title = (KIND_CN[ins.kind] || ins.kind) + (ins.line ? ' · C++ 第 ' + ins.line + ' 行' : '');
      frag.appendChild(row);
      asmRows.push(row);
    });
    list.appendChild(frag);
  }
  var lastPcRow = -1;
  function highlightPC() {
    if (lastPcRow >= 0 && asmRows[lastPcRow]) asmRows[lastPcRow].classList.remove('pc');
    if (!S.m || S.m.halted && S.m.pc >= S.prog.instrs.length) { lastPcRow = -1; return; }
    var i = S.m.pc;
    if (asmRows[i]) {
      asmRows[i].classList.add('pc');
      lastPcRow = i;
      var list = $('asmList');
      var top = asmRows[i].offsetTop;
      if (top < list.scrollTop + 20 || top > list.scrollTop + list.clientHeight - 40)
        list.scrollTop = top - list.clientHeight / 2;
    }
  }

  /* ---------------- 寄存器 / 标志 ---------------- */
  function render(ef) {
    if (!S.m) { $('regs').innerHTML = ''; $('flags').innerHTML = ''; $('memView').innerHTML = ''; updateStatus(); return; }
    highlightPC();
    var ins = S.prog.instrs[S.m.pc];
    highlightSrcLine(ins && ins.line ? ins.line : 0);
    renderRegs(ef);
    renderFlags(ef);
    renderMem(ef);
    renderDatapath(ef);
    renderOutput();
    renderTrace();
    updateStatus();
  }

  function renderRegs(ef) {
    var t = S.prog.target, m = S.m;
    var changed = {};
    if (ef && ef.regs) ef.regs.forEach(function (r) { changed[r.name] = 1; });
    var html = '';
    t.regs.forEach(function (r) {
      var v = m.regs[r] || 0;
      var d = M.sgn(t.bits === 64 ? v : M.u32(v), t.bits === 64 ? 64 : 32);
      html += '<div class="reg' + (changed[r] ? ' chg' : '') + '"><span class="n">' + r + '</span>' +
              '<span class="h">' + hex(v, t.bits) + '</span><span class="d">' + d + '</span></div>';
    });
    var pcv = MEM.CODE_BASE + m.pc * 4;
    html += '<div class="reg"><span class="n">' + t.pcName + '</span><span class="h">' + hex(pcv, t.bits) + '</span>' +
            '<span class="d">#' + m.pc + '</span></div>';
    $('regs').innerHTML = html;
  }

  function renderFlags(ef) {
    var t = S.prog.target, f = S.m.flags;
    var chg = ef && ef.flags ? ' chg' : '';
    var map = t.flagStyle === 'x86'
      ? [['ZF', f.Z, '结果为零'], ['SF', f.N, '结果为负'], ['CF', f.C, '无借位/进位'], ['OF', f.V, '有符号溢出']]
      : [['N', f.N, '负'], ['Z', f.Z, '零'], ['C', f.C, '进位/无借位'], ['V', f.V, '溢出']];
    $('flags').innerHTML = map.map(function (x) {
      return '<span class="flag' + (x[1] ? ' set' : '') + chg + '" title="' + x[2] + '"><b>' + x[0] + '</b> ' + (x[1] ? 1 : 0) + '</span>';
    }).join('');
  }

  /* ---------------- 内存视图 ---------------- */
  function renderMem(ef) {
    if (S.memTab === 'stack') renderStack(ef);
    else if (S.memTab === 'data') renderData(ef);
    else renderCallStack();
  }

  function curFrameVars() {
    var top = S.m.callStack[S.m.callStack.length - 1];
    if (!top) return null;
    var fr = S.prog.frames[top.name];
    if (!fr) return null;
    var fpv = S.m.regs[S.prog.target.alias[S.prog.target.fp] || S.prog.target.fp] || 0;
    var map = {};
    fr.vars.forEach(function (v) {
      for (var b = 0; b < v.size; b += v.elemSize) {
        var a = fpv - v.offset + b;
        map[a] = v.name + (v.count > 1 ? '[' + (b / v.elemSize) + ']' : '') + (v.isParam ? ' (参数)' : '');
      }
    });
    return { map: map, fp: fpv, fn: top.name };
  }

  function renderStack(ef) {
    var m = S.m, t = S.prog.target, W = S.prog.W;
    var sp = m.regs[t.alias[t.sp] || t.sp] || 0;
    var info = curFrameVars() || { map: {}, fp: -1 };
    var chg = {};
    if (ef && ef.mem) ef.mem.forEach(function (x) { for (var i = 0; i < x.size / 8; i += 4) chg[x.addr + i] = 1; });
    var start = Math.max(MEM.DATA_BASE, sp - 3 * W);
    var end = MEM.STACK_TOP;
    var rows = [], a;
    for (a = start; a < end && rows.length < 90; a += W) {
      var v = M.memRead(m, a, W * 8, false);
      var marks = [];
      if (a === sp) marks.push('<span class="mk">◀ ' + t.sp + '</span>');
      if (a === info.fp) marks.push('<span class="mkf">◀ ' + t.fp + '</span>');
      // 一个字长的行里可能放着多个 4 字节变量（例如对象的两个 int 成员），都标注出来
      for (var q = 0; q < W; q += 4) if (info.map[a + q]) marks.push(info.map[a + q]);
      if (v >= MEM.CODE_BASE && v < MEM.CODE_BASE + S.prog.instrs.length * 4) marks.push('返回地址 → #' + ((v - MEM.CODE_BASE) / 4));
      if (v === M.SENTINEL) marks.push('程序结束哨兵');
      rows.push('<div class="mrow' + (a === sp ? ' sp' : '') + (a === info.fp ? ' fp' : '') + (chg[a] ? ' chg' : '') + '">' +
        '<span class="a">' + hex(a, 32).slice(2) + '</span><span class="v">' + hex(v, W * 8) + '</span>' +
        '<span class="t">' + marks.join('  ') + '</span></div>');
    }
    $('memView').innerHTML = '<div class="muted" style="margin-bottom:3px">当前函数 <b style="color:#38bdf8">' + (info.fn || '-') +
      '</b>　栈顶 ' + hex(sp, 32) + '　已用 ' + (MEM.STACK_TOP - sp) + ' 字节</div>' + rows.join('');
  }

  function renderData(ef) {
    var m = S.m;
    var chg = {};
    if (ef && ef.mem) ef.mem.forEach(function (x) { chg[x.addr] = 1; });
    var html = '';
    S.prog.globalInfo.forEach(function (gv) {
      html += '<div class="gvar"><div class="gh">' + esc(gv.name) + ' <small>' + esc(gv.type) + ' @ ' + hex(gv.addr, 32) + '</small></div>';
      if (gv.str !== undefined) {
        html += '<div class="cells"><span class="cell" style="min-width:auto">"' + esc(gv.str.replace(/\n/g, '\\n')) + '"</span></div>';
      } else {
        html += '<div class="cells">';
        for (var i = 0; i < gv.count && i < 64; i++) {
          var a = gv.addr + i * gv.elemSize;
          var v = M.memRead(m, a, gv.elemSize * 8, true);
          html += '<span class="cell' + (chg[a] ? ' chg' : '') + '">' + v + '<i>' + i + '</i></span>';
        }
        html += '</div>';
      }
      html += '</div>';
    });
    if (!html) html = '<div class="muted">本程序没有全局数据</div>';
    $('memView').innerHTML = html;
  }

  function renderCallStack() {
    var m = S.m;
    var html = '<div class="cstack">';
    for (var i = m.callStack.length - 1; i >= 0; i--) {
      var f = m.callStack[i];
      var note = f.retIdx < 0 ? '程序入口' : '被 C++ 第 ' + f.line + ' 行调用，返回地址 = 指令 #' + f.retIdx;
      if (i === m.callStack.length - 1) note = '← 当前执行中　' + note;
      html += '<div class="cframe"><b>' + esc(f.name) + '()</b>' +
        '<small>' + note + '　栈帧深度 ' + i + '</small></div>';
    }
    html += '</div>';
    $('memView').innerHTML = html;
  }

  /* ---------------- 数据通路 ---------------- */
  function buildDatapath() {
    var w = 128, gap = 20, x0 = 6, y = 6, h = 40;
    var blocks = $('dpBlocks'), arrows = $('dpArrows');
    var NS = 'http://www.w3.org/2000/svg';
    DP_BLOCKS.forEach(function (b, i) {
      var x = x0 + i * (w + gap);
      var gEl = document.createElementNS(NS, 'g');
      gEl.setAttribute('class', 'dp-block'); gEl.id = 'dp-' + b.id;
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('rx', 6);
      var t1 = document.createElementNS(NS, 'text');
      t1.setAttribute('class', 't'); t1.setAttribute('x', x + w / 2); t1.setAttribute('y', y + 26);
      t1.textContent = b.t;
      var t2 = document.createElementNS(NS, 'text');
      t2.setAttribute('class', 'v'); t2.setAttribute('x', x + w / 2); t2.setAttribute('y', y + 62); t2.id = 'dpv-' + b.id;
      var t3 = document.createElementNS(NS, 'text');
      t3.setAttribute('class', 'v'); t3.setAttribute('x', x + w / 2); t3.setAttribute('y', y + 78); t3.id = 'dpv2-' + b.id;
      gEl.appendChild(r); gEl.appendChild(t1); gEl.appendChild(t2); gEl.appendChild(t3);
      blocks.appendChild(gEl);
      if (i < DP_BLOCKS.length - 1) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('class', 'dp-arrow'); p.id = 'dpa-' + i;
        p.setAttribute('d', 'M' + (x + w) + ',' + (y + h / 2) + ' L' + (x + w + gap - 3) + ',' + (y + h / 2));
        p.setAttribute('marker-end', 'url(#ah)');
        arrows.appendChild(p);
      }
    });
    $('dpStages').innerHTML = ['IF', 'ID', 'EX', 'MEM', 'WB'].map(function (s) {
      return '<span id="stg-' + s + '">' + STAGE_CN[s] + '</span>';
    }).join('');
  }

  function dpSet(id, a, b) {
    var e1 = $('dpv-' + id), e2 = $('dpv2-' + id);
    if (e1) e1.textContent = a === undefined || a === null ? '' : String(a).slice(0, 22);
    if (e2) e2.textContent = b === undefined || b === null ? '' : String(b).slice(0, 22);
  }
  function renderDatapath(ef) {
    var t = S.prog.target;
    DP_BLOCKS.forEach(function (b) { $('dp-' + b.id).classList.remove('on'); });
    ['IF', 'ID', 'EX', 'MEM', 'WB'].forEach(function (s) { $('stg-' + s).classList.remove('on'); });
    document.querySelectorAll('.dp-arrow').forEach(function (a) { a.classList.remove('on'); });

    if (!ef || !ef.instr) {
      $('dpInstr').textContent = S.m && S.m.halted ? '程序已结束' : '等待执行…';
      DP_BLOCKS.forEach(function (b) { dpSet(b.id, '', ''); });
      dpSet('pc', hex(MEM.CODE_BASE + (S.m ? S.m.pc : 0) * 4, 32));
      return;
    }
    var ins = ef.instr;
    $('dpInstr').textContent = ins.text;
    var stages = ef.stages || [];
    stages.forEach(function (s) {
      var el = $('stg-' + s); if (el) el.classList.add('on');
      (STAGE_BLOCKS[s] || []).forEach(function (b) { var x = $('dp-' + b); if (x) x.classList.add('on'); });
    });
    document.querySelectorAll('.dp-arrow').forEach(function (a, i) { if (i < stages.length + 1) a.classList.add('on'); });

    dpSet('pc', hex(ins.addr, 32), '#' + ef.pc);
    dpSet('imem', ins.text.replace(/\s+/g, ' ').slice(0, 24), ins.line ? 'C++ 第 ' + ins.line + ' 行' : '');
    dpSet('dec', KIND_CN[ins.kind] || ins.kind, ins.fn ? 'in ' + ins.fn + '()' : '');
    var reads = [];
    ['a', 'b', 'src', 'base', 'r1', 'r2', 'm1', 'm2'].forEach(function (k) { if (ins[k] && typeof ins[k] === 'string') reads.push(ins[k]); });
    dpSet('rf', reads.length ? '读 ' + reads.slice(0, 3).join(',') : '', ef.regs.length ? '写 ' + ef.regs[0].name : '');
    if (ef.alu) {
      var A = ef.alu;
      dpSet('alu', A.op + (A.b === null || A.b === undefined ? ' ' + A.a : ' ' + A.a + ', ' + A.b), '= ' + A.r + (A.note ? ' (' + A.note + ')' : ''));
    } else if (ef.branch) {
      dpSet('alu', ef.branch.taken ? '条件成立 → 跳转' : '条件不成立', ef.branch.to || '');
    } else dpSet('alu', '', '');
    if (ef.memOp) dpSet('dmem', (ef.memOp.rw === 'R' ? '读 ' : '写 ') + hex(ef.memOp.addr, 32), '值 ' + ef.memOp.val + ' (' + ef.memOp.size + '位)');
    else dpSet('dmem', '', '');
    if (ef.regs.length) {
      var r0 = ef.regs[ef.regs.length - 1];
      dpSet('wb', r0.name + ' ← ' + hex(r0.val, t.bits), '原 ' + hex(r0.old, t.bits));
    } else if (ef.out) dpSet('wb', '输出 ' + JSON.stringify(ef.out).slice(0, 18), '');
    else dpSet('wb', '', '');
  }

  /* ---------------- 输出 / 轨迹 / 状态 ---------------- */
  function renderOutput() {
    var m = S.m;
    $('output').textContent = m.output || '（暂无输出）';
    var v = $('verdict');
    var p = CE.PROGRAMS[S.progIdx];
    if (!m.halted) { v.innerHTML = '<span class="wait">程序运行中…</span>'; return; }
    var lines = [];
    if (m.error) lines.push('<span class="bad">✘ 运行时错误：' + esc(m.error) + '</span>');
    else lines.push('<span class="ok">■ 程序正常结束</span>，main 返回值 = <b>' + m.exitCode + '</b>，共执行 <b>' + m.count + '</b> 条指令');
    var want = expectFor(p, S.arch);
    if (!isEdited() && want !== undefined) {
      lines.push(m.output === want
        ? '<span class="ok">✔ 输出与预期一致，本次模拟验证通过（' + esc(S.prog.target.title) + '）</span>'
        : '<span class="bad">✘ 输出与预期不符　预期：' + esc(JSON.stringify(want)) + '　实际：' + esc(JSON.stringify(m.output)) + '</span>');
    } else if (isEdited()) {
      lines.push('<span class="wait">（源码已修改，无预期输出可比对）</span>');
    }
    v.innerHTML = lines.join('<br>');
  }

  function pushTrace(ef) {
    if (!ef || !ef.instr) return;
    var parts = [];
    ef.regs.forEach(function (r) { parts.push(r.name + '=' + hex(r.val, S.prog.target.bits)); });
    ef.mem.forEach(function (x) { parts.push('[' + hex(x.addr, 32) + ']=' + x.val); });
    if (ef.flags) { var f = S.m.flags; parts.push('flags N' + (+f.N) + 'Z' + (+f.Z) + 'C' + (+f.C) + 'V' + (+f.V)); }
    if (ef.out) parts.push('输出 ' + JSON.stringify(ef.out));
    if (ef.branch) parts.push(ef.branch.taken ? '跳转 → ' + ef.branch.to : '不跳转');
    if (ef.call) parts.push('调用 ' + ef.call + '()');
    if (ef.ret) parts.push(ef.ret === 'exit' ? '程序退出' : '返回');
    var head = '<span class="t-pc">' + pad('#' + ef.pc, 5) + ' ' + hex(ef.instr.addr, 32) + '</span>  ';
    var body = esc(ef.instr.text);
    while (body.length < 34) body += ' ';
    var tail = parts.length ? '<span class="t-chg">; ' + esc(parts.join('  ')) + '</span>' : '';
    S.trace.push(head + body + tail);
    if (S.trace.length > 600) S.trace.splice(0, 200);
  }
  function renderTrace() {
    var el = $('trace');
    el.innerHTML = S.trace.slice(-260).join('\n');
    el.scrollTop = el.scrollHeight;
  }
  function updateStatus() {
    var st = $('status');
    if (!S.m) { st.innerHTML = '<b>未装载</b>'; return; }
    st.innerHTML = '架构 <b>' + S.prog.target.title + '</b>　已执行 <b>' + S.m.count + '</b> 条　' +
      (S.dirty ? '<b style="color:#fbbf24">源码已改，需重新编译</b>' : (S.m.halted ? '<b>已停止</b>' : (S.running ? '<b style="color:#4ade80">运行中</b>' : '<b>就绪</b>')));
  }

  /* ---------------- 执行控制 ---------------- */
  function doStep() {
    if (!S.m || S.m.halted) return false;
    var ef = M.step(S.m);
    S.lastEf = ef;
    pushTrace(ef);
    return !S.m.halted;
  }
  function toggleRun() {
    if (S.running) pause(); else startRun();
  }
  function startRun() {
    if (!S.m || S.m.halted) return;
    S.running = true;
    $('btnRun').textContent = '⏸ 暂停';
    loop();
  }
  function pause() {
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    var b = $('btnRun'); if (b) b.textContent = '▶ 运行';
    updateStatus();
  }
  function loop() {
    if (!S.running) return;
    var sp = SPEEDS[S.speed], acc = { regs: [], mem: [], instr: null };
    var last = null, hitBp = false;
    var traceOn = sp.batch <= 20;
    for (var i = 0; i < sp.batch; i++) {
      if (S.m.halted) break;
      var ef = M.step(S.m);
      last = ef;
      if (traceOn) pushTrace(ef);
      if (ef) { acc.regs = acc.regs.concat(ef.regs); acc.mem = acc.mem.concat(ef.mem); }
      if (S.bps.has(S.m.pc) && !S.m.halted) { hitBp = true; break; }
    }
    if (!traceOn && last) {
      S.trace.push('<span class="t-pc">…… 快速执行 ' + sp.batch + ' 条指令 ……</span>');
      pushTrace(last);
    }
    S.lastEf = last;
    if (last) { last = Object.assign({}, last, { regs: acc.regs, mem: acc.mem }); }
    render(last);
    if (S.m.halted || hitBp) { pause(); return; }
    S.timer = setTimeout(loop, sp.iv);
  }

  /* ---------------- 四架构对比 ---------------- */
  function runCompare() {
    var src = $('src').value;
    var p = CE.PROGRAMS[S.progIdx];
    var rows = '', cols = '';
    CE.ARCH_IDS.forEach(function (id) {
      var prog, m, err = null;
      try {
        prog = CE.compile(src, id);
        m = M.create(prog);
        M.run(m, 3000000);
      } catch (e) { err = e.message; }
      var t = prog ? prog.target : CE.makeTarget(id);
      if (err) {
        rows += '<tr><td>' + t.title + '</td><td colspan="6" class="bad">编译失败：' + esc(err) + '</td></tr>';
        return;
      }
      var real = prog.instrs.filter(function (x) { return x.kind !== 'label' && x.kind !== 'dir'; }).length;
      var want = expectFor(p, id);
      var ok = !m.error && (!isEdited() && want !== undefined ? m.output === want : true);
      rows += '<tr><td><b>' + t.title + '</b></td><td>' + t.bits + ' 位</td><td>' + esc(t.syntax.split('·').pop().trim()) + '</td>' +
        '<td>' + (t.maxRegArgs ? '前 ' + t.maxRegArgs + ' 个用寄存器' : '全部压栈') + '</td>' +
        '<td>' + real + '</td><td>' + m.count + '</td>' +
        '<td class="' + (ok ? 'ok' : 'bad') + '">' + (m.error ? '运行错误：' + esc(m.error) : (ok ? '✔ 通过' : '✘ 输出不符')) + '</td></tr>';
      var body = prog.asmText.split('\n');
      cols += '<div class="cmp-col"><h4>' + t.title + '</h4><pre>' + esc(body.join('\n')) + '</pre></div>';
    });
    $('cmpResult').innerHTML =
      '<table class="cmp"><tr><th>架构</th><th>字长</th><th>调用约定</th><th>参数传递</th><th>静态指令数</th><th>执行指令数</th><th>输出验证</th></tr>' +
      rows + '</table><div class="cmp-cols">' + cols + '</div>';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);

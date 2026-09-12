/* 命令行自测：7 个示例程序 × 4 种架构，比对输出与返回值 */
const fs = require('fs'), path = require('path');
['frontend', 'targets', 'codegen', 'machine', 'programs'].forEach(f => {
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'));
});
const CE = globalThis.CE;

let pass = 0, fail = 0;
const only = process.argv[2];
for (const p of CE.PROGRAMS) {
  if (only && p.id !== only) continue;
  const counts = [];
  for (const arch of CE.ARCH_IDS) {
    let prog;
    try {
      prog = CE.compile(p.code, arch);
    } catch (e) {
      console.log(`✗ ${p.id.padEnd(7)} ${arch.padEnd(7)} 编译失败: ${e.message}${e.line ? ' (第 ' + e.line + ' 行)' : ''}`);
      fail++; continue;
    }
    const m = CE.Machine.create(prog);
    CE.Machine.run(m, 3000000);
    const want = (p.expectByArch && p.expectByArch[arch] !== undefined) ? p.expectByArch[arch] : p.expect;
    const ok = !m.error && m.output === want;
    if (ok) { pass++; counts.push(`${arch}:${m.count}`); }
    else {
      fail++;
      console.log(`✗ ${p.id.padEnd(7)} ${arch.padEnd(7)} err=${m.error || '-'}`);
      console.log(`    期望: ${JSON.stringify(want)}`);
      console.log(`    实际: ${JSON.stringify(m.output)}`);
      if (process.env.DUMP) {
        console.log(prog.asmText.split('\n').slice(0, 200).join('\n'));
      }
    }
  }
  if (counts.length === 4) console.log(`✓ ${p.id.padEnd(7)} 指令数  ${counts.join('  ')}`);
}
console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

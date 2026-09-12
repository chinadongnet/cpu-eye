/* ============================================================
 * CPU-EYE  内置示例程序
 * 每个示例带有 expect（预期输出），运行结束后自动比对，
 * 既是教学用例，也是模拟器自身的验证用例。
 * ============================================================ */
(function (g) {
  'use strict';
  var CE = (g.CE = g.CE || {});

  CE.PROGRAMS = [
    {
      id: 'sum',
      name: '① 循环累加',
      focus: '循环 / 加法 / 函数调用',
      desc: '最基础的 for 循环累加。适合观察累加器寄存器、循环变量在栈帧中的更新，以及条件跳转如何构成循环。',
      expect: 'sum(1..10) = 55\n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        '// 求 1..n 的和',
        'int sum_to(int n) {',
        '    int s = 0;',
        '    for (int i = 1; i <= n; i = i + 1) {',
        '        s = s + i;',
        '    }',
        '    return s;',
        '}',
        '',
        'int main() {',
        '    int n = 10;',
        '    int r = sum_to(n);',
        '    cout << "sum(1.." << n << ") = " << r << endl;',
        '    return 0;',
        '}'
      ].join('\n')
    },
    {
      id: 'fact',
      name: '② 递归阶乘',
      focus: '函数栈帧 / 递归 / 返回地址',
      desc: '递归调用，每一层都会压入新的栈帧。重点看调用栈面板与栈内存中保存的返回地址、旧帧指针。',
      expect: '1! = 1\n2! = 2\n3! = 6\n4! = 24\n5! = 120\n6! = 720\n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int fact(int n) {',
        '    if (n <= 1) return 1;',
        '    return n * fact(n - 1);',
        '}',
        '',
        'int main() {',
        '    for (int i = 1; i <= 6; i = i + 1) {',
        '        cout << i << "! = " << fact(i) << endl;',
        '    }',
        '    return 0;',
        '}'
      ].join('\n')
    },
    {
      id: 'bubble',
      name: '③ 冒泡排序',
      focus: '数组 / 指针传参 / 内存写入',
      desc: '全局数组 + 指针参数。数据段面板会实时显示数组元素交换的过程，是观察 load/store 指令最直观的例子。',
      expect: '1 2 3 4 5 7 8 9 \n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int arr[8] = {5, 2, 9, 1, 7, 3, 8, 4};',
        '',
        'void bubble(int *a, int n) {',
        '    for (int i = 0; i < n - 1; i = i + 1) {',
        '        for (int j = 0; j < n - 1 - i; j = j + 1) {',
        '            if (a[j] > a[j + 1]) {',
        '                int t = a[j];',
        '                a[j] = a[j + 1];',
        '                a[j + 1] = t;',
        '            }',
        '        }',
        '    }',
        '}',
        '',
        'int main() {',
        '    bubble(arr, 8);',
        '    for (int i = 0; i < 8; i = i + 1) {',
        '        cout << arr[i] << " ";',
        '    }',
        '    cout << endl;',
        '    return 0;',
        '}'
      ].join('\n')
    },
    {
      id: 'fib',
      name: '④ 斐波那契数列',
      focus: '局部数组 / 栈上内存 / 下标寻址',
      desc: '局部数组分配在栈帧里。观察 [fp - 偏移] 形式的寻址，以及数组下标如何被缩放成字节偏移（×4）。',
      expect: '0 1 1 2 3 5 8 13 21 34 55 89 \n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int main() {',
        '    int f[12];',
        '    f[0] = 0;',
        '    f[1] = 1;',
        '    for (int i = 2; i < 12; i = i + 1) {',
        '        f[i] = f[i - 1] + f[i - 2];',
        '    }',
        '    for (int i = 0; i < 12; i = i + 1) {',
        '        cout << f[i] << " ";',
        '    }',
        '    cout << endl;',
        '    return f[11];',
        '}'
      ].join('\n')
    },
    {
      id: 'gcd',
      name: '⑤ 辗转相除法',
      focus: '取模 / while 循环 / 除法指令差异',
      desc: '同一个取模运算，x86 用 idiv 一条指令同时得到商和余数，ARM 则需要 sdiv + msub/mls 两条指令。切换架构对比最明显。',
      expect: 'gcd(252,105) = 21\ngcd(1071,462) = 21\n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int gcd(int a, int b) {',
        '    while (b != 0) {',
        '        int t = a % b;',
        '        a = b;',
        '        b = t;',
        '    }',
        '    return a;',
        '}',
        '',
        'int main() {',
        '    cout << "gcd(252,105) = " << gcd(252, 105) << endl;',
        '    cout << "gcd(1071,462) = " << gcd(1071, 462) << endl;',
        '    return 0;',
        '}'
      ].join('\n')
    },
    {
      id: 'ptr',
      name: '⑥ 指针与数组',
      focus: '指针算术 / 取地址 / 解引用',
      desc: '指针加法会按元素大小自动缩放。64 位架构下指针占 8 字节，32 位下占 4 字节，栈帧布局会随之变化。',
      expect: 'max = 33\nq[0]=12 q[2]=33\n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int data[6] = {12, -4, 33, 7, 33, 20};',
        '',
        'int max_of(int *p, int n) {',
        '    int best = *p;',
        '    for (int i = 1; i < n; i = i + 1) {',
        '        if (*(p + i) > best) {',
        '            best = *(p + i);',
        '        }',
        '    }',
        '    return best;',
        '}',
        '',
        'int main() {',
        '    int mx = max_of(data, 6);',
        '    cout << "max = " << mx << endl;',
        '    int *q = data;',
        '    cout << "q[0]=" << q[0] << " q[2]=" << q[2] << endl;',
        '    return mx;',
        '}'
      ].join('\n')
    },
    {
      id: 'prime',
      name: '⑦ 素数筛选',
      focus: '条件分支 / 提前返回 / 标志位',
      desc: '大量条件判断。重点观察 cmp 指令如何设置标志位（x86 的 ZF/SF，ARM 的 NZCV），以及条件跳转如何读取它们。',
      expect: '2 3 5 7 11 13 17 19 23 29 \ncount = 10\n',
      code: [
        '#include <iostream>',
        'using namespace std;',
        '',
        'int is_prime(int x) {',
        '    if (x < 2) return 0;',
        '    for (int d = 2; d * d <= x; d = d + 1) {',
        '        if (x % d == 0) return 0;',
        '    }',
        '    return 1;',
        '}',
        '',
        'int main() {',
        '    int cnt = 0;',
        '    for (int i = 2; i <= 30; i = i + 1) {',
        '        if (is_prime(i)) {',
        '            cout << i << " ";',
        '            cnt = cnt + 1;',
        '        }',
        '    }',
        '    cout << endl << "count = " << cnt << endl;',
        '    return cnt;',
        '}'
      ].join('\n')
    }
  ];
})(typeof window !== 'undefined' ? window : globalThis);

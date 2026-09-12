/* 由 index.html 生成可发布到网页端的 artifact-page.html（去掉外层骨架标签） */
const fs = require('fs');
let h = fs.readFileSync(__dirname + '/index.html', 'utf8');
h = h.replace(/<!doctype html>\s*/i, '')
     .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
     .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
     .replace(/<body[^>]*>\s*/i, '').replace(/<\/body>\s*/i, '')
     .replace(/<meta charset[^>]*>\s*/i, '')
     .replace(/<meta name="viewport"[^>]*>\s*/i, '')
     .replace('<title>CPU-EYE 处理器模拟器</title>', '<title>CPU-EYE</title>');
fs.writeFileSync(__dirname + '/artifact-page.html', h.trim() + '\n');
console.log('已生成 artifact-page.html');

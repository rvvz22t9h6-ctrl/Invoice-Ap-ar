/**
 * 將單一 HTML 檔轉為 claude.ai Artifact 頁面格式：
 * 平台發佈時會自動加上 <!doctype>、<html>、<head>、<body>，
 * 因此只保留 <title>、樣式、根節點與程式。
 * 輸出：dist-artifact/finance-portal.html
 */
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist-artifact/index.html', 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>Finance Portal</title>';
// Google Fonts 是 Artifact 允許的唯一字型來源
const fontLinks = [...html.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g)].map((m) => m[0]);
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);
if (!styles.length || !scripts.length) throw new Error('Expected inlined styles and scripts in dist-artifact/index.html');

const page = [
  title,
  ...fontLinks,
  // 本頁刻意採用單一淺色外觀（白色背景、海軍藍導覽列）
  '<style>:root{color-scheme:light}body{background:#ffffff;color:#0f172a}</style>',
  ...styles,
  '<div id="root"></div>',
  ...scripts,
].join('\n');
// 部分函式庫（UTF-8 解碼、XML 字元表）在字串中直接含有 U+FFFD 字元；
// 發佈工具會把它視為損毀字元，因此改寫成等價的跳脫序列 \uFFFD（皆位於 JS 樣板字串內）。
const escaped = page.replace(/\uFFFD/g, '\\uFFFD');
writeFileSync('dist-artifact/finance-portal.html', `${escaped}\n`);
console.log(`finance-portal.html: ${(page.length / 1024 / 1024).toFixed(2)} MB`);

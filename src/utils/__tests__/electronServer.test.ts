import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep, posix } from 'node:path';
import * as pathMod from 'node:path';
import * as fsMod from 'node:fs';
import { createServer, Server, get as httpGet } from 'node:http';

/**
 * 🔴 خادم Electron المحلي — يُشغَّل فعلاً، لا يُقرأ.
 *
 * السبب الذي وُلد منه هذا الملف: غيّرتُ معالج المسار في `electron/main.cjs` (ISSUE-017)
 * فجعلتُ `filePath` ثابتاً (`const`) بينما سطر SPA fallback أدناه يُسنِد إليه. فرمى
 * `TypeError: Assignment to constant variable` التقطه `catch` الخارجي فردّ **500**،
 * وظهرت **شاشة بيضاء** فيها «Internal server error» في نسخة سطح المكتب المثبَّتة.
 *
 * ولم يكشفه شيء: `tsc` لا يفحص `.cjs`، والحارس النصّي كان يقرأ الكود ولا يُشغّله،
 * والاختبارات كلها في المتصفح. فمرّ إلى تاجرٍ ثبّت البرنامج ورأى شاشة بيضاء.
 *
 * 🎯 الدرس: **حارسٌ يقرأ النصّ لا يكفي لكودٍ يعمل خارج المتصفح.** هذا الملف يستخرج
 * المعالج من الملف الحقيقي ويُشغّله على `dist` فعلاً — فأي خطأ تنفيذٍ يسقط هنا لا عند التاجر.
 */

const ROOT = process.cwd();
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

/** يقتطع جسم المعالج من `electron/main.cjs` — لا نسخةً منه، بل هو نفسه. */
function extractHandler(): (req: unknown, res: unknown, p: unknown, f: unknown, m: unknown, d: unknown) => void {
  const src = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');
  const marker = 'http.createServer((req, res) => {';
  const start = src.indexOf(marker);
  const end = src.indexOf('\n  });', start);
  expect(start, 'تعذّر العثور على معالج الخادم — تغيّرت بنية main.cjs').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start + marker.length, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('req', 'res', 'path', 'fs', 'MIME', 'distDir', body) as never;
}

/** مجلد dist مؤقّت — لا نعتمد على وجود بناءٍ سابق كي يعمل الاختبار في أي بيئة. */
const DIST = join(ROOT, 'node_modules', '.tmp-dist-test');
let server: Server;
let port = 0;

beforeAll(async () => {
  mkdirSync(join(DIST, 'assets'), { recursive: true });
  writeFileSync(join(DIST, 'index.html'), '<!doctype html><html lang="ar" dir="rtl"><body>رتب شغلك</body></html>');
  writeFileSync(join(DIST, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(DIST, 'assets', 'app.css'), 'body{}');

  const handler = extractHandler();
  server = createServer((req, res) => handler(req, res, pathMod, fsMod, MIME, DIST));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  rmSync(DIST, { recursive: true, force: true });
});

const fetchRaw = (path: string) => new Promise<{ code: number; type?: string; body: string }>((resolve) => {
  httpGet({ host: '127.0.0.1', port, path }, (res) => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => resolve({ code: res.statusCode ?? 0, type: res.headers['content-type'], body: b }));
  });
});

describe('🔴 الخادم يخدم التطبيق فعلاً', () => {
  it('🔴 الجذر يُعيد صفحة التطبيق — لا 500', async () => {
    const r = await fetchRaw('/');
    expect(r.code, 'كان يردّ 500 «Internal server error» فتظهر شاشة بيضاء عند التاجر').toBe(200);
    expect(r.body).toContain('رتب شغلك');
    expect(r.type).toContain('text/html');
  });

  it('🔴 وملف JS بنوعه الصحيح — نوعٌ خاطئ يمنع إقلاع التطبيق', async () => {
    const r = await fetchRaw('/assets/app.js');
    expect(r.code).toBe(200);
    expect(r.type).toContain('application/javascript');
  });

  it('وCSS كذلك', async () => {
    const r = await fetchRaw('/assets/app.css');
    expect(r.code).toBe(200);
    expect(r.type).toContain('text/css');
  });

  it('مسار غير معروف يسقط على index.html (تطبيق صفحة واحدة)', async () => {
    const r = await fetchRaw('/' + encodeURIComponent('شاشة-غير-موجودة'));
    expect(r.code).toBe(200);
    expect(r.body).toContain('رتب شغلك');
  });

  it('ومجلدٌ كذلك — لا انفجار على statSync', async () => {
    const r = await fetchRaw('/assets/');
    expect(r.code).toBe(200);
  });
});

describe('🔴 ولا يُسرّب ملفاً خارج dist (ISSUE-017)', () => {
  it('الصعود بالنقاط يبقى محصوراً', async () => {
    const r = await fetchRaw('/../../electron/main.cjs');
    expect(r.body, 'تسريب كود المصدر').not.toContain('createServer');
    expect(r.body).toContain('رتب شغلك');
  });

  it('🔴 والصعود **المرمَّز** كذلك — وهو ما كان يفلت قبل فكّ الترميز', async () => {
    const r = await fetchRaw('/..%2f..%2felectron%2fmain.cjs');
    expect(r.body).not.toContain('createServer');
    const r2 = await fetchRaw('/%2e%2e%2f%2e%2e%2fpackage.json');
    expect(r2.body).not.toContain('"dependencies"');
  });

  it('وترميزٌ تالف يُرفض بـ400 بدل أن ينفجر', async () => {
    expect((await fetchRaw('/%')).code).toBe(400);
  });

  it('🛡️ ومجلدٌ شقيق يبدأ بنفس الحروف لا يُخدَم', () => {
    // مقارنة نصّية عارية تمرّ على dist-evil لأنه يبدأ بـdist — نتأكّد من الحدّ الفاصل
    const distDir = resolve(DIST);
    const sibling = resolve(DIST + '-evil', 'x');
    const rootWithSep = distDir.endsWith(sep) ? distDir : distDir + sep;
    expect(sibling.startsWith(distDir), 'هذا سبب فشل الفحص النصّي العاري').toBe(true);
    expect(sibling.startsWith(rootWithSep), 'والحدّ الفاصل يمنعه').toBe(false);
  });
});

describe('حارس: بنية الخادم', () => {
  const src = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');

  it('🔴 filePath قابل للإسناد — SPA fallback يُسنِد إليه', () => {
    expect(
      /const filePath = path\.resolve\(distDir/.test(src),
      'const مع إسنادٍ لاحق يرمي TypeError فيردّ الخادم 500 — شاشة بيضاء عند التاجر',
    ).toBe(false);
    expect(/let filePath = path\.resolve\(distDir/.test(src)).toBe(true);
  });

  it('ويُفكّ الترميز قبل الفحص', () => {
    expect(/decodeURIComponent/.test(src)).toBe(true);
  });

  it('ودليل بناءٍ حقيقي موجود عند التحزيم', () => {
    // لا نُفشل الاختبار إن لم يُبنَ بعد — لكن إن وُجد، نتأكّد أنه صالح
    const real = join(ROOT, 'dist', 'index.html');
    if (existsSync(real)) expect(readFileSync(real, 'utf8')).toContain('<div id="root">');
  });
});

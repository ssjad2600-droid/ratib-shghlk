/**
 * جلب خط IBM Plex Sans Arabic إلى داخل المشروع وتوليد `src/fonts.css`.
 *
 * 🔴 لماذا؟ الخط يُجلب اليوم من CDN جوجل عند كل إقلاع (`index.html`). وهذا يعني:
 *
 *   · **أول تشغيل بلا إنترنت يظهر بخطٍّ احتياطي** — والتطبيق مبنيٌّ ليعمل أوفلاين،
 *     فمن غير المقبول أن تكون هويته البصرية أول ما يسقط عند انقطاع الشبكة.
 *   · نسخة أندرويد أصلها `capacitor://localhost`، وسياسة CSP `default-src 'self'`
 *     تحجب نطاقاً خارجياً ما لم يُستثنَ — واستثناؤه يوسّع سطح الهجوم بلا داعٍ.
 *   · كل إقلاع يدفع رحلتَي شبكة (`fonts.googleapis` ثم `fonts.gstatic`) قبل الرسم.
 *
 * 🎯 وتُجلب مجموعتان فقط من أربع: **العربية واللاتينية**. لا سيريلية ولا لاتينية
 * موسّعة — لا يظهر منهما حرفٌ واحد في البرنامج، وجلبهما يضاعف الحجم بلا فائدة.
 *
 * التشغيل:  node scripts/fetch-fonts.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(root, 'src', 'assets', 'fonts');
const CSS_OUT = join(root, 'src', 'fonts.css');

const FAMILY = 'IBM Plex Sans Arabic';
const WEIGHTS = [400, 500, 600, 700];
const SUBSETS = ['arabic', 'latin'];

/** جوجل تُقدّم woff2 لوكيلٍ حديث فقط؛ وبدونه تعود بصيغة ttf أثقل بكثير. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CSS_URL = `https://fonts.googleapis.com/css2?family=${
  FAMILY.replace(/ /g, '+')}:wght@${WEIGHTS.join(';')}&display=swap`;

/** كل كتلة @font-face مسبوقةٌ بتعليقٍ يحمل اسم المجموعة الفرعية. */
const BLOCK = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
const field = (block, name) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

async function main() {
  const res = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`تعذّر جلب CSS الخط: ${res.status}`);
  const css = await res.text();

  mkdirSync(FONT_DIR, { recursive: true });

  const faces = [];
  for (const [, subset, block] of css.matchAll(BLOCK)) {
    if (!SUBSETS.includes(subset)) continue;

    const weight = field(block, 'font-weight');
    const range = field(block, 'unicode-range');
    const url = field(block, 'src')?.match(/url\(([^)]+)\)/)?.[1];
    if (!weight || !range || !url) throw new Error(`كتلة @font-face ناقصة (${subset})`);

    const name = `ibm-plex-sans-arabic-${weight}-${subset}.woff2`;
    const bin = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!bin.ok) throw new Error(`تعذّر جلب ${name}: ${bin.status}`);
    const buf = Buffer.from(await bin.arrayBuffer());
    writeFileSync(join(FONT_DIR, name), buf);

    faces.push({ weight: Number(weight), subset, name, range, bytes: buf.length });
  }

  const expected = WEIGHTS.length * SUBSETS.length;
  if (faces.length !== expected) {
    throw new Error(`المتوقّع ${expected} ملفاً والمجلوب ${faces.length} — تغيّرت مجموعات جوجل؟`);
  }

  // ترتيبٌ ثابت (الوزن ثم المجموعة) كي لا يتغيّر الملف المولَّد بين تشغيلين
  faces.sort((a, b) => a.weight - b.weight || a.subset.localeCompare(b.subset));

  const out = [
    '/* ⚠️ ملفٌ مولَّد — لا تُعدّله يدوياً. أعِد توليده بـ: node scripts/fetch-fonts.mjs */',
    '',
    ...faces.map(f => [
      `/* ${f.subset} */`,
      '@font-face {',
      `  font-family: '${FAMILY}';`,
      '  font-style: normal;',
      `  font-weight: ${f.weight};`,
      '  font-display: swap;',
      `  src: url('./assets/fonts/${f.name}') format('woff2');`,
      `  unicode-range: ${f.range};`,
      '}',
      '',
    ].join('\n')),
  ].join('\n');

  writeFileSync(CSS_OUT, out);

  const total = faces.reduce((s, f) => s + f.bytes, 0);
  console.log(`✅ ${faces.length} ملفاً في src/assets/fonts/ — ${(total / 1024).toFixed(1)} KB إجمالاً`);
  for (const f of faces) console.log(`   ${f.name} — ${(f.bytes / 1024).toFixed(1)} KB`);
  console.log('✅ src/fonts.css');
}

main().catch(err => { console.error(err); process.exit(1); });

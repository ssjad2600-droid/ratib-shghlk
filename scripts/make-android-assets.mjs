/**
 * توليد موارد أندرويد (الأيقونات وشاشة البداية) من `build/icon.svg`.
 *
 * 🔴 لماذا وُجد هذا السكربت؟ لأن `npx cap add android` نسخ **أيقونة Capacitor
 * الافتراضية** (حرف X أزرق) وشعارها في شاشة البداية، وبقيت في المشروع. أي أن
 * أول ما يراه التاجر على شاشة هاتفه رمزٌ لا علاقة له بـ«رتب شغلك».
 *
 * والتوليد من المصدر المتّجه لا بالنسخ اليدوي: فإذا تغيّرت الأيقونة يوماً، أمرٌ
 * واحد يُعيد بناء الاثنين والعشرين ملفاً متّسقة.
 *
 * ثلاث صيغ لأن أندرويد يعرض الأيقونة بثلاث طرق حسب إصدار النظام:
 *
 *   · `ic_launcher` / `ic_launcher_round` — أندرويد ٧ فما دون: صورةٌ واحدة
 *     جاهزة. المستديرة تُقنَّع بدائرة هنا لأن النظام القديم لا يقصّها بنفسه.
 *
 *   · `ic_launcher_foreground` + `ic_launcher_background` — أندرويد ٨ فصاعداً
 *     (الأيقونة التكيّفية): طبقتان يقصّهما المصنّع بالشكل الذي يختاره — دائرة
 *     على Pixel، مربعٌ مستدير على سامسونغ، معيّن على غيرها. ولذلك:
 *
 *     🔴 المحتوى يُصغَّر إلى ٧٨٪ ويُتوسَّط. الرقم ليس ذوقاً: ذيل السهم عند
 *     (٨٤، ٤٢٢) هو أبعد نقطةٍ عن المركز، وقناع الدائرة يُظهر نصف قطر ١٧٠px من
 *     أصل ٢٥٦. حُسب المقياس ليقع الذيل عند ١٦٩٫٤px — داخل القناع بشعرة. أي
 *     مقياسٍ أكبر يقصّ بداية السهم على هواتف Pixel.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'build', 'icon.svg');
const RES = join(root, 'android', 'app', 'src', 'main', 'res');

const BG_RECT = '<rect x="32" y="32" width="448" height="448" rx="104" fill="url(#ab)"/>';
const GLOSS = '<path d="M32 224 Q256 360 480 200 L480 136 Q480 32 376 32 L136 32 Q32 32 32 136 Z" fill="#ffffff" opacity="0.08"/>';
const FULL_BLEED = '<rect x="0" y="0" width="512" height="512" fill="url(#ab)"/>';
const BLEED = 512 / 448;

/** كحليّ العلامة — نفس `theme_color` في الـmanifest وخلفية شاشة الدخول. */
const BRAND_NAVY = '#0B1F4D';

/** إزاحة مركز المحتوى عن مركز الإطار (محسوبة من إحداثيات المصدر). */
const CONTENT_DX = 16;
const CONTENT_DY = -15;
/** انظر التعليق أعلاه — ليس رقماً اعتباطياً. */
const SAFE_SCALE = 0.78;

const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

/** المقاسات كما وجدها `cap add android` — تُقرأ لا تُفترض. */
const SPLASHES = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];

function split(svg) {
  for (const [needle, what] of [[BG_RECT, 'مستطيل الخلفية'], [GLOSS, 'الطبقة اللامعة']]) {
    if (!svg.includes(needle)) {
      throw new Error(`تعذّر العثور على ${what} في build/icon.svg — عُدّل المصدر؟`);
    }
  }
  const head = svg.split(BG_RECT)[0];
  const content = svg.split(GLOSS)[1].replace('</svg>', '');
  return { head, content };
}

const scaleAboutCenter = (inner, k) =>
  `<g transform="translate(256,256) scale(${k}) translate(-256,-256)">${inner}</g>`;

/** الأيقونة القديمة: خلفية مالئة + لمعة + محتوى بـ٨٥٪ (كصيغة maskable للويب). */
function legacy(svg) {
  const { head, content } = split(svg);
  return head + FULL_BLEED + scaleAboutCenter(GLOSS, BLEED) + scaleAboutCenter(content, 0.85) + '</svg>';
}

/** طبقة الخلفية التكيّفية: التدرّج واللمعة بلا محتوى. */
function adaptiveBackground(svg) {
  const { head } = split(svg);
  return head + FULL_BLEED + scaleAboutCenter(GLOSS, BLEED) + '</svg>';
}

/** طبقة المقدّمة التكيّفية: المحتوى وحده على شفافية، متوسَّطاً ومصغَّراً. */
function adaptiveForeground(svg) {
  const { head, content } = split(svg);
  const centered = `<g transform="translate(${CONTENT_DX},${CONTENT_DY})">${content}</g>`;
  return head + scaleAboutCenter(centered, SAFE_SCALE) + '</svg>';
}

const circleMask = (size) => Buffer.from(
  `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
);

async function main() {
  if (!existsSync(RES)) throw new Error(`مجلّد موارد أندرويد غير موجود: ${RES}`);
  const svg = readFileSync(SRC, 'utf8');

  const legacySvg = Buffer.from(legacy(svg));
  const bgSvg = Buffer.from(adaptiveBackground(svg));
  const fgSvg = Buffer.from(adaptiveForeground(svg));

  let count = 0;
  const emit = async (pipeline, dir, name) => {
    await pipeline.png().toFile(join(RES, dir, name));
    count++;
  };

  for (const [d, launcher, adaptive] of DENSITIES) {
    const dir = `mipmap-${d}`;
    await emit(sharp(legacySvg).resize(launcher, launcher), dir, 'ic_launcher.png');
    await emit(
      sharp(legacySvg).resize(launcher, launcher)
        .composite([{ input: circleMask(launcher), blend: 'dest-in' }]),
      dir, 'ic_launcher_round.png'
    );
    await emit(sharp(bgSvg).resize(adaptive, adaptive), dir, 'ic_launcher_background.png');
    await emit(sharp(fgSvg).resize(adaptive, adaptive), dir, 'ic_launcher_foreground.png');
  }

  // شاشة البداية: كحليّ العلامة والأيقونة في وسطه — نفس ما تراه العين في شاشة الدخول
  for (const [dir, w, h] of SPLASHES) {
    const logo = Math.round(Math.min(w, h) * 0.34);
    const badge = await sharp(Buffer.from(svg)).resize(logo, logo).png().toBuffer();
    await emit(
      sharp({ create: { width: w, height: h, channels: 4, background: BRAND_NAVY } })
        .composite([{ input: badge, gravity: 'centre' }]),
      dir, 'splash.png'
    );
  }

  console.log(`✅ وُلّد ${count} ملفاً في android/.../res من build/icon.svg`);
}

main().catch((err) => { console.error(err); process.exit(1); });

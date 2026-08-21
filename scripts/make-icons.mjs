/**
 * توليد أيقونات الهاتف والويب من `build/icon.svg` — مصدرٌ متجهٌ واحد لكل المقاسات.
 *
 * على نمط `build/make-ico.cjs` الذي يولّد أيقونة ويندوز؛ هذا يولّد ما تحتاجه
 * الشاشة الرئيسية على الهاتف والمتصفح.
 *
 * 🔴 لماذا ثلاث صيغ لا صيغة واحدة؟ لأن كل منصة تقصّ الأيقونة بشكلٍ مختلف:
 *
 *   · `icon-192/512`      — كما هي: مستطيلٌ مستدير بزوايا شفافة. هذا ما يعرضه
 *                           المتصفح ونافذة «تثبيت التطبيق».
 *
 *   · `icon-maskable-512` — أندرويد يقصّ الأيقونة بشكلٍ يختاره المصنّع (دائرة،
 *                           مربع، معيّن…). فإن تركنا زوايا شفافة ظهرت الأيقونة
 *                           مقصوصةً أو محاطةً بإطارٍ أبيض. لذا: خلفية تملأ الإطار
 *                           كاملاً، والمحتوى مصغَّرٌ إلى ٨٥٪ ليبقى داخل «المنطقة
 *                           الآمنة» مهما كان شكل القصّ.
 *
 *   · `apple-touch-icon`  — 🔴 iOS **يعرض الشفافية سوداء**. فأيقونةٌ بزوايا شفافة
 *                           تظهر على آيفون بإطارٍ أسود قبيح. لذا تُسطَّح على خلفية
 *                           معتمة. وقناع iOS يقصّ الزوايا قليلاً فقط، فلا حاجة
 *                           لتصغير المحتوى هنا.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'build', 'icon.svg');
const OUT = join(root, 'public', 'icons');

/**
 * مستطيل الخلفية في المصدر — مُزاحٌ ٣٢px بزوايا مستديرة.
 * يُستبدل بمستطيلٍ يملأ الإطار في الصيغ التي لا تحتمل الشفافية.
 */
const BG_RECT = '<rect x="32" y="32" width="448" height="448" rx="104" fill="url(#ab)"/>';
const FULL_BLEED = '<rect x="0" y="0" width="512" height="512" fill="url(#ab)"/>';

/**
 * الطبقة اللامعة — منحنىً أبيض شفيف مرسومٌ ليُقصّ بحافة البطاقة فيبدو انعكاساً.
 *
 * 🔴 هذه **خلفية لا محتوى**. تصغيرها مع البارات والسهم يُبعدها عن الحواف فتظهر
 * بقعةً طافيةً ذات حدٍّ حادّ بدل انعكاسٍ ممتدّ. لذا تُكبَّر مع الخلفية (٥١٢/٤٤٨)
 * بينما يُصغَّر المحتوى وحده.
 */
const GLOSS = '<path d="M32 224 Q256 360 480 200 L480 136 Q480 32 376 32 L136 32 Q32 32 32 136 Z" fill="#ffffff" opacity="0.08"/>';

/** يوسّع رقعة العنصر من مربّع ٤٤٨ إلى إطار ٥١٢ الكامل. */
const BLEED_SCALE = 512 / 448;

const scaleAboutCenter = (inner, k) =>
  `<g transform="translate(256,256) scale(${k}) translate(-256,-256)">${inner}</g>`;

/**
 * يبني نسخةً بخلفيةٍ مالئة: الخلفية واللمعة تملآن الإطار، والمحتوى وحده يُصغَّر.
 *
 * 🔴 يرمي إن لم يجد أياً من العنصرين: لو عُدّلت `icon.svg` لاحقاً، الأفضل أن
 * يتوقّف التوليد بصوتٍ عالٍ من أن يُخرج أيقونةً مشوّهةً بصمت.
 */
function fullBleed(svg, contentScale) {
  for (const [needle, what] of [[BG_RECT, 'مستطيل الخلفية'], [GLOSS, 'الطبقة اللامعة']]) {
    if (!svg.includes(needle)) {
      throw new Error(`تعذّر العثور على ${what} في build/icon.svg — عُدّل المصدر؟\nالمتوقّع: ${needle}`);
    }
  }
  const [head, tail] = svg.split(BG_RECT);
  const content = tail.split(GLOSS)[1].replace('</svg>', '');
  return head
    + FULL_BLEED
    + scaleAboutCenter(GLOSS, BLEED_SCALE)
    + (contentScale === 1 ? content : scaleAboutCenter(content, contentScale))
    + '</svg>';
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const svg = readFileSync(SRC, 'utf8');

  const png = (source, size) => sharp(Buffer.from(source)).resize(size, size).png();

  const written = [];
  const emit = async (name, pipeline) => {
    const file = join(OUT, name);
    const info = await pipeline.toFile(file);
    written.push(`${name} — ${(info.size / 1024).toFixed(1)} KB`);
  };

  // كما هي — زوايا شفافة، لـ purpose:"any"
  await emit('icon-192.png', png(svg, 192));
  await emit('icon-512.png', png(svg, 512));

  // أندرويد: خلفية مالئة + محتوى داخل المنطقة الآمنة (٨٥٪)
  await emit('icon-maskable-512.png', png(fullBleed(svg, 0.85), 512));

  // iOS: معتمة تماماً — flatten يزيل قناة الشفافية فلا يظهر إطارٌ أسود
  await emit(
    'apple-touch-icon.png',
    png(fullBleed(svg, 1), 180).flatten({ background: '#0369a1' })
  );

  // أيقونة تبويب المتصفح — كانت مفقودة (٤٠٤ في الطرفية)
  await emit('favicon-32.png', png(svg, 32));
  copyFileSync(SRC, join(root, 'public', 'favicon.svg'));
  written.push('favicon.svg — نسخة من المصدر');

  console.log('✅ public/icons/:');
  for (const w of written) console.log('   ' + w);
}

main().catch(err => { console.error(err); process.exit(1); });

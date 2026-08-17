/**
 * مولّد باركود **Code 128** — بلا أي مكتبة خارجية.
 *
 * لماذا بلا مكتبة: مكتبات الباركود تضخّم حجم البرنامج وقد تتعطّل عند تحديث،
 * والخوارزمية نفسها جدول أنماط ودالة تحقّق. أقلّ اعتماديات = برنامج أثبت لمن يشتريه.
 *
 * لماذا Code 128 لا EAN-13: المنتج الذي يحمل EAN-13 حقيقياً يأتي وعليه باركود المصنع
 * مطبوعاً — لا يُعاد طبعه. والملصقات التي يطبعها التاجر هي للبضاعة المحلية بلا رقم عالمي.
 * وكل ماسح في السوق يقرأ Code 128 بلا إعداد.
 */

/** جدول أنماط Code 128: كل نمط عرضُ عناصره بالتناوب (شريط، فراغ، شريط...) بدءاً بشريط. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const STOP = 106;

/** هل الكود أرقام كلها وبطول زوجي؟ ⇒ يُرمَّز بـ Code C فينضغط للنصف (مهم للملصق الضيّق). */
const usesCodeC = (value: string): boolean => /^\d+$/.test(value) && value.length % 2 === 0;

/**
 * يحوّل النص إلى قائمة قيم Code 128 (بلا التحقّق ولا الإيقاف).
 * الاستراتيجية مقصودة البساطة: أرقام بطول زوجي ⇒ Code C كاملاً، وإلا Code B.
 * الخلط الأمثل بين المجموعتين يوفّر أشرطة قليلة مقابل تعقيد يُنتج أخطاء يصعب كشفها.
 * (ولهذا يولّد البرنامج أكواداً داخلية بطول زوجي دائماً — لتنضغط تلقائياً.)
 */
function encodeValues(value: string): { values: number[]; start: number } {
  if (usesCodeC(value)) {
    const values: number[] = [];
    for (let i = 0; i < value.length; i += 2) values.push(parseInt(value.slice(i, i + 2), 10));
    return { values, start: START_C };
  }
  const values: number[] = [];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    // Code B يغطي ASCII القابل للطباعة ٣٢..١٢٦
    values.push(code >= 32 && code <= 126 ? code - 32 : 0);
  }
  return { values, start: START_B };
}

export interface Barcode128 {
  /** أعرض العناصر بالتناوب بدءاً بشريط أسود (بوحدات الوحدة الأساسية) */
  elements: number[];
  /** مجموع الوحدات — يحدّد العرض الفعلي: العرض = الوحدات × عرض الوحدة */
  modules: number;
  encoding: 'B' | 'C';
}

/** هل النص صالح للترميز أصلاً؟ (ASCII قابل للطباعة فقط) */
export const isEncodable = (value: string): boolean =>
  value.length > 0 && /^[\x20-\x7E]+$/.test(value);

/** يبني تمثيل الباركود: الأنماط + رمز التحقّق + الإيقاف. */
export function encodeCode128(value: string): Barcode128 | null {
  if (!isEncodable(value)) return null;
  const { values, start } = encodeValues(value);

  // رمز التحقّق: (البداية + مجموع (الموضع × القيمة)) بباقي القسمة على ١٠٣
  let sum = start;
  values.forEach((v, i) => { sum += v * (i + 1); });
  const check = sum % 103;

  const indices = [start, ...values, check, STOP];
  const elements: number[] = [];
  for (const idx of indices) for (const ch of PATTERNS[idx]) elements.push(Number(ch));

  return {
    elements,
    modules: elements.reduce((s, n) => s + n, 0),
    encoding: start === START_C ? 'C' : 'B',
  };
}

/**
 * أقلّ عرض وحدة يُقرأ عملياً بالمليمتر.
 * على طابعة ٢٠٣ نقطة/بوصة تساوي النقطة ٠٫١٢٥ملم، وشريط بوحدة أقلّ من نقطتين يتلاشى.
 * نستخدمه لتحذير المستخدم **قبل** أن يهدر ورقة كاملة بملصقات لا تُقرأ.
 */
export const MIN_MODULE_MM = 0.25;

/** المنطقة الهادئة: فراغ أبيض إلزامي على الجانبين، وإلا فشل المسح مهما كان الشريط واضحاً. */
export const QUIET_MODULES = 10;

export interface BarcodeFit {
  ok: boolean;
  moduleMm: number;      // عرض الوحدة الناتج ضمن العرض المتاح
  neededMm: number;      // أقلّ عرض ملصق يجعل الباركود مقروءاً
  modules: number;
}

/** هل يتّسع هذا الكود داخل عرض متاح (بالمليمتر) بجودة قابلة للقراءة؟ */
export function fitBarcode(value: string, availableMm: number): BarcodeFit | null {
  const bc = encodeCode128(value);
  if (!bc) return null;
  const total = bc.modules + QUIET_MODULES * 2;
  const moduleMm = availableMm / total;
  return {
    ok: moduleMm >= MIN_MODULE_MM,
    moduleMm,
    neededMm: total * MIN_MODULE_MM,
    modules: total,
  };
}

/**
 * يرسم الباركود SVG بأبعاد **مليمترية حقيقية**.
 *
 * `shape-rendering="crispEdges"` إلزامي: بدونه يُنعّم المتصفح الحواف فتتداخل الأشرطة
 * مع جيرانها ويفشل المسح. والألوان أسود صافٍ على أبيض صافٍ — لا رمادي ولا خلفية.
 */
export function barcodeSvg(value: string, widthMm: number, heightMm: number): string {
  const bc = encodeCode128(value);
  if (!bc) return '';
  const total = bc.modules + QUIET_MODULES * 2;
  const unit = widthMm / total;

  let x = QUIET_MODULES * unit;
  let isBar = true; // النمط يبدأ دائماً بشريط
  const rects: string[] = [];
  for (const w of bc.elements) {
    if (isBar) rects.push(`<rect x="${x.toFixed(4)}" y="0" width="${(w * unit).toFixed(4)}" height="${heightMm}" fill="#000"/>`);
    x += w * unit;
    isBar = !isBar;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" shape-rendering="crispEdges" preserveAspectRatio="none"><rect width="${widthMm}" height="${heightMm}" fill="#fff"/>${rects.join('')}</svg>`;
}

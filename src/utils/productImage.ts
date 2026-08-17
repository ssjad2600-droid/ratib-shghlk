/**
 * صورة المنتج — تصغير وضغط قبل التخزين.
 *
 * 🔴 العلّة: الصورة تُخزَّن **Base64 داخل وثيقة المنتج**، والنموذج كان يقبل حتى ٢ ميغابايت.
 * لكن:
 *   · حدّ Firestore لحجم الوثيقة الواحدة **١ ميبي بايت** (1,048,576 بايت)
 *   · وBase64 يُضخّم الحجم **٣٣٪** تقريباً
 *
 * فأي صورة فوق ~٧٥٠ كيلوبايت تجعل الكتابة **تفشل**. والكتابة `fire-and-forget` بلا
 * معالجة إلا `console.error` — فيرى التاجر «تم حفظ المنتج بنجاح» ولا يُحفظ شيء. صورةٌ
 * من كاميرا هاتف حديث تتجاوز هذا الحد دائماً.
 *
 * وأثرٌ ثانٍ أهدأ: وثيقة المنتج تُقرأ في كل شاشة تعرض المنتجات، فالصور تُنزَّل مع كل
 * قراءة. على ٣٠٠٠ منتج هذا عبء دائم على صاحب البرنامج (قراءات Firestore).
 *
 * الحل: تصغير الصورة إلى مقاس يكفي للعرض (٤٠٠ بكسل) وإعادة ترميزها JPEG — فتنزل من
 * ميغابايتات إلى عشرات الكيلوبايتات، وتبقى واضحة في بطاقة المنتج التي لا تتجاوز ٨٠ بكسل.
 */

/** أقصى حجم للنصّ المُرمَّز داخل الوثيقة. محافظ عمداً: الوثيقة تحمل حقولاً أخرى. */
export const MAX_IMAGE_DATA_BYTES = 200 * 1024;

/** أطول ضلع بعد التصغير — يكفي لبطاقة المنتج ولمعاينة أكبر عند الحاجة. */
export const IMAGE_MAX_EDGE = 400;

export const IMAGE_TOO_LARGE =
  'تعذّر تصغير الصورة إلى حجم مناسب — جرّب صورة أبسط أو أصغر';

export const IMAGE_NOT_AN_IMAGE = 'الملف المختار ليس صورة';

/**
 * حجم `data:` URL بالبايت (طول الحمولة المُرمَّزة لا طول النصّ).
 * دالة نقية — هي موضع الاختبار، أما الرسم على canvas فيلزمه متصفح.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** هل يُقبل هذا النصّ للتخزين داخل وثيقة المنتج؟ */
export const fitsInDocument = (dataUrl: string, maxBytes = MAX_IMAGE_DATA_BYTES): boolean =>
  dataUrlBytes(dataUrl) <= maxBytes;

/**
 * 🔴 شعار المحل — كان الوحيد بلا ضغط.
 *
 * كانت شاشة الإعدادات تقبل حتى **٢٫٥ ميغا** وتخزّنها Base64 خاماً. وترميز Base64 يزيد
 * ٣٣٪ فتصير ٣٫٣٣ ميغا، وحدّ وثيقة Firestore **١ ميغا** — أي أن كل شعار بين ٧٦٨ كيلو
 * و٢٫٥ ميغا يمرّ من الفحص ثم **تفشل كتابته**، ورسالة «تم الحفظ بنجاح 🎉» تظهر قبل أن
 * يُعرف شيء. والحلّ كان موجوداً في هذا الملف نفسه منذ إصلاح صور المنتجات.
 *
 * حدّ أصغر وضلع أقصر: الشعار يظهر في ترويسة الفاتورة وبطاقة الشاشة، ولا يحتاج أكثر.
 */
export const MAX_LOGO_DATA_BYTES = 120 * 1024;
export const LOGO_MAX_EDGE = 300;

/** الأبعاد بعد التصغير مع الحفاظ على النسبة. لا تُكبّر صورة صغيرة أصلاً. */
export function scaledSize(w: number, h: number, maxEdge = IMAGE_MAX_EDGE): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge || longest === 0) return { w, h };
  const ratio = maxEdge / longest;
  return { w: Math.max(1, Math.round(w * ratio)), h: Math.max(1, Math.round(h * ratio)) };
}

/**
 * يقرأ ملف صورة ويُعيد `data:` URL مصغَّراً ومضغوطاً.
 *
 * يُخفّض الجودة تدريجياً إن بقي الناتج كبيراً (صور معقّدة)، ويرفض صراحةً إن تعذّر —
 * فلا يُكتب في الوثيقة ما يُفشل حفظها بصمت.
 */
export async function compressImage(
  file: File,
  maxEdge: number = IMAGE_MAX_EDGE,
  maxBytes: number = MAX_IMAGE_DATA_BYTES,
): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(IMAGE_NOT_AN_IMAGE);

  const sourceUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(IMAGE_NOT_AN_IMAGE));
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onerror = () => reject(new Error(IMAGE_NOT_AN_IMAGE));
    el.onload = () => resolve(el);
    el.src = sourceUrl;
  });

  const { w, h } = scaledSize(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(IMAGE_TOO_LARGE);
  // خلفية بيضاء: PNG الشفّاف يصير أسود عند التحويل إلى JPEG
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  for (const quality of [0.72, 0.6, 0.45, 0.3]) {
    const out = canvas.toDataURL('image/jpeg', quality);
    if (fitsInDocument(out, maxBytes)) return out;
  }
  throw new Error(IMAGE_TOO_LARGE);
}

/** صورة منتج — الحدود الافتراضية. */
export const compressProductImage = (file: File): Promise<string> => compressImage(file);

/** شعار المحل — أصغر ضلعاً وحجماً، فهو ترويسة لا بطاقة. */
export const compressLogo = (file: File): Promise<string> =>
  compressImage(file, LOGO_MAX_EDGE, MAX_LOGO_DATA_BYTES);

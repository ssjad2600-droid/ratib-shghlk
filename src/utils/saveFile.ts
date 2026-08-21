import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * حفظ ملفٍ للمستخدم — قناةٌ واحدة تعرف أين تعمل.
 *
 * 🔴 العلّة: كل التصدير في البرنامج (نسخة احتياطية، CSV، Word) يبني Blob ثم
 * يصنع `<a download>` ويضغطه برمجياً. وهذا **لا يعمل على الهاتف**:
 *   · iOS/WKWebView: يتجاهل `download` تماماً — لا شيء يحدث، بلا خطأ ولا رسالة.
 *     فيضغط التاجر «تصدير» فلا يرى شيئاً، ويظنّ البرنامج معطّلاً.
 *   · أندرويد/WebView: يُنزَّل إلى صندوقٍ رملي لا يصله مدير الملفات، فالملف
 *     «نُزّل» ولا يجده صاحبه. والنسخة الاحتياطية أخطر ما يُفقد بهذه الطريقة.
 *
 * 🎯 والحلّ ورقةُ مشاركة النظام: يكتب الملف في مجلّد مؤقّت ثم يفتح ورقة
 * المشاركة، فيختار التاجر واتساب أو درايف أو «حفظ في الملفات» — وهو ما يفعله
 * فعلاً بنسخته الاحتياطية.
 *
 * ⚠️ ونقطةٌ واحدة تخدم ١٢+ موضع استدعاء: `exportDoc` و`csv` و`exportBackup`.
 * إصلاحها موضعاً موضعاً يعني أن أول موضعٍ يُنسى يُعيد العلّة صامتة — وهو نمطٌ
 * متّبع في هذا المستودع (`writeGuard`, `saleWrite`).
 */

/** ما يجب أن يُحقن في الاختبارات — لا لتخفيف شيء بل ليُختبر بلا جهاز. */
export interface SaveDeps {
  isNative: () => boolean;
  webSave: (blob: Blob, filename: string) => void;
  nativeWrite: (opts: { path: string; data: string; directory: Directory; encoding?: Encoding }) => Promise<{ uri: string }>;
  nativeShare: (opts: { title?: string; files: string[]; dialogTitle?: string }) => Promise<unknown>;
}

/**
 * محارف تكسر أسماء الملفات على أندرويد وويندوز.
 *
 * 🔴 العربية **تبقى كما هي** عمداً: اسم «نسخة_رتب_شغلك_…» يعرّف التاجرَ بملفه.
 * المحذوف هو ما يمنعه نظام الملفات فقط — واستبدالُ الاسم كلّه بلاتينيةٍ يجعل
 * التاجر لا يميّز نسخته من غيرها في مجلّد التنزيلات.
 */
/**
 * فواصل المسارات والمحارف المحجوزة، **ومحارف التحكّم** (U+0000–U+001F):
 * نظام الملفات يرفضها، وبايت NUL قد يقصّ الاسم صامتاً في طبقاتٍ أدنى.
 * والمسافة ليست منها — تُحوَّل إلى `_` في السطر التالي، وهو أوضح للقراءة.
 *
 * ⚠️ المدى مكتوبٌ بترميز `\u` صراحةً: كتابته بمحارف حرفية تُدخل بايتات تحكّمٍ
 * فعلية في الملف المصدري، فيصير ثنائياً لا يُقرأ في git diff ولا في المحرّرات.
 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001F]/g;

export function safeFilename(name: string): string {
  const cleaned = name.replace(ILLEGAL, '-').replace(/\s+/g, '_').trim();
  // أندرويد يقصّ ما تجاوز ٢٥٥ بايتاً؛ والعربية حرفان لكل محرف في UTF-8
  return (cleaned || 'ملف').slice(0, 100);
}

const webSaveDefault = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/** يحوّل Blob إلى base64 — وهو ما يقبله Filesystem للبيانات الثنائية. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // على دفعات: `String.fromCharCode(...arr)` على ملفٍ كبير يتجاوز حدّ المعاملات ويرمي
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const defaults = (): SaveDeps => ({
  isNative: () => Capacitor.isNativePlatform(),
  webSave: webSaveDefault,
  nativeWrite: opts => Filesystem.writeFile(opts),
  nativeShare: opts => Share.share(opts),
});

export type SaveOutcome = 'downloaded' | 'shared';

/**
 * يحفظ الملف بالطريقة المناسبة للمنصّة.
 *
 * يرمي عند فشل المسار الأصلي — فالمستدعي يعرض العطل بدل ادّعاء نجاحٍ كاذب.
 * (وهذا هو الدرس نفسه الذي وُلد منه `writeGuard`: الفشل الصامت أسوأ من الفشل.)
 */
export async function saveFile(
  blob: Blob,
  filename: string,
  deps: SaveDeps = defaults(),
): Promise<SaveOutcome> {
  const name = safeFilename(filename);

  if (!deps.isNative()) {
    deps.webSave(blob, name);
    return 'downloaded';
  }

  // Directory.Cache: مؤقّتٌ بطبعه — الملف وسيطٌ إلى ورقة المشاركة لا أرشيف.
  // وDocuments يحتاج صلاحياتٍ على إصداراتٍ قديمة، فيفشل عند بعض التجّار دون غيرهم.
  const { uri } = await deps.nativeWrite({
    path: name,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
  });

  await deps.nativeShare({ title: name, files: [uri], dialogTitle: 'حفظ أو مشاركة الملف' });
  return 'shared';
}

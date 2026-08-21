import { Capacitor } from '@capacitor/core';
import { AppLauncher } from '@capacitor/app-launcher';

/**
 * فتح رابطٍ **خارج** التطبيق — واتساب، الهاتف، المواقع.
 *
 * 🔴 العلّة داخل WebView: `window.open(url, '_blank')` قد يفتح الرابط **داخل**
 * إطار التطبيق نفسه، فيغرق التاجر في صفحةٍ بلا شريط عنوان ولا زرّ رجوع مرئي،
 * ويظنّ أن البرنامج «علّق». وتذكيرات الديون عبر واتساب من أكثر ما يستعمله يومياً.
 *
 * 🎯 و`AppLauncher.openUrl` **يسلّم الرابط لنظام التشغيل** — وهذا هو الفرق الجوهري:
 * أندرويد يربط `https://wa.me/...` بتطبيق واتساب المثبَّت، فيُفتح التطبيق نفسه
 * بالمحادثة جاهزة. أما `@capacitor/browser` فيفتح متصفّحاً داخلياً يعرض
 * **واتساب-ويب** ويطلب مسح رمز QR — تجربةٌ أسوأ من لا شيء.
 *
 * وعلى الكمبيوتر والمتصفّح: `window.open` كما كان تماماً، بلا أي تغيير.
 */

export interface OpenDeps {
  isNative: () => boolean;
  launch: (url: string) => Promise<unknown>;
  webOpen: (url: string) => void;
}

const defaults = (): OpenDeps => ({
  isNative: () => Capacitor.isNativePlatform(),
  launch: url => AppLauncher.openUrl({ url }),
  // `noopener` يمنع الصفحة المفتوحة من الوصول إلى `window.opener` — احتياطٌ معروف
  webOpen: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
});

/**
 * يفتح الرابط بالطريقة المناسبة. لا يرمي: تعذّرُ فتح واتساب لا يجوز أن يُسقط
 * الشاشة التي يعمل فيها التاجر — وعند الفشل نجرّب المسار الشبكي بدل الاستسلام.
 */
export async function openExternal(url: string, deps: OpenDeps = defaults()): Promise<boolean> {
  if (!deps.isNative()) {
    deps.webOpen(url);
    return true;
  }
  try {
    await deps.launch(url);
    return true;
  } catch {
    // احتياطي: قد لا يكون التطبيق المستهدف مثبّتاً، فيفتح المتصفّح الصفحة
    try { deps.webOpen(url); return true; } catch { return false; }
  }
}

/**
 * مُعالِج ضغطٍ لروابط `<a target="_blank">` القائمة.
 *
 * 🎯 يقرأ الرابط من الوسم نفسه (`currentTarget.href`) لا من مُعامل: فتعبير الرابط
 * في تلك الوسوم طويلٌ ومركّب (`https://wa.me/?text=${encodeURIComponent(...)}`)،
 * وتكرارُه في `onClick` يعني نسختين تنحرفان يوماً — وقد وقع ذلك في هذا المستودع.
 *
 * ويمنع السلوك الافتراضي **على الهاتف وحده**؛ وعلى الكمبيوتر يعمل الرابط كما هو
 * تماماً، فتبويبٌ جديد هناك هو المتوقَّع ولا داعي لاعتراضه.
 */
export function onExternalLink(e: {
  preventDefault: () => void;
  currentTarget: { href?: string } | null;
}): void {
  if (!Capacitor.isNativePlatform()) return;
  const url = e.currentTarget?.href;
  // `href="#"` هو حالة «لا رقم هاتف» في بعض الشاشات — نتركها للسلوك الافتراضي
  if (!url || url.endsWith('#')) return;
  e.preventDefault();
  void openExternal(url);
}

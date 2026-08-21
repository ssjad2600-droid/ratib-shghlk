/**
 * فحص توفّر تحديثٍ للتطبيق.
 *
 * 🔴 لماذا يلزم أصلاً؟ لأن التطبيق يُوزَّع **خارج المتاجر**: ملف APK يُنزَّل من
 * موقع المزوّد. ولا متجر يعني **لا تحديث تلقائي**: يبقى التاجر على نسخةٍ فيها
 * علّةٌ أُصلحت قبل أشهر، ولا يعلم أن إصلاحها موجود. وهذا في برنامج محاسبةٍ يُباع
 * ليس نقصَ راحةٍ بل خطرٌ تشغيلي.
 *
 * والمقارنة هنا **نقيّة بلا شبكة**: تُختبر وحدةً، ويُحقن مصدر البيانات.
 */

/**
 * مقارنة إصدارين بصيغة `1.2.3`.
 *
 * 🔴 لا تُقارَن نصّياً: `'1.10.0' > '1.9.0'` **خطأ** نصّياً لأن `'1' < '9'`، فيبقى
 * التاجر على ١٫٩ ولا يُعرض عليه ١٫١٠ أبداً — وهو أوّل خطأٍ يقع فيه كل من كتب هذا.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    String(v).trim().split(/[.\-+]/).map(p => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** هل `latest` أحدث من `current`؟ */
export const isNewerVersion = (latest: string, current: string): boolean =>
  compareVersions(latest, current) > 0;

export interface ReleaseInfo {
  /** رقم الإصدار المنشور، مثل `1.1.0` */
  version?: unknown;
  /** رابط التنزيل المباشر */
  url?: unknown;
  /** سطرٌ يشرح ما الجديد — يُعرض للتاجر */
  notes?: unknown;
}

export interface UpdateAvailable {
  version: string;
  url: string;
  notes: string;
}

/**
 * يقرّر هل يُعرض إشعار تحديث.
 *
 * ⚠️ **متحفّظة عمداً**: أي نقصٍ أو تشوّهٍ في الوثيقة ⟶ لا إشعار. فإشعارُ تحديثٍ
 * برابطٍ فارغ أو نسخةٍ غير مفهومة يُربك التاجر ويدفعه لمكالمة دعم، بينما صمتُ
 * الإشعار لا يُفقده شيئاً — نسخته تعمل.
 */
export function updateFrom(
  release: ReleaseInfo | null | undefined,
  currentVersion: string,
): UpdateAvailable | null {
  if (!release) return null;

  const version = typeof release.version === 'string' ? release.version.trim() : '';
  const url = typeof release.url === 'string' ? release.url.trim() : '';
  if (!version || !url) return null;

  // رابطٌ آمن فقط: `javascript:` أو `data:` في وثيقةٍ يُقرأها كل المستخدمين
  // تصير مسار تنفيذٍ لو غُيّرت الوثيقة يوماً.
  if (!/^https:\/\//i.test(url)) return null;

  if (!isNewerVersion(version, currentVersion)) return null;

  const notes = typeof release.notes === 'string' ? release.notes.trim() : '';
  return { version, url, notes };
}

/**
 * مفتاح المنصّة في مجموعة `appRelease`.
 *
 * الويب لا يُفحص: نسخة المتصفّح تُحدَّث بذاتها عند كل زيارة، وإشعارُ تحديثٍ فيها
 * بلا معنى — بل مُربك.
 */
export type ReleasePlatform = 'android' | 'ios' | 'windows';

export function releasePlatform(
  isNative: boolean,
  platform: string,
  isElectron: boolean,
): ReleasePlatform | null {
  if (isNative) {
    if (platform === 'android') return 'android';
    if (platform === 'ios') return 'ios';
    return null;
  }
  return isElectron ? 'windows' : null;
}

import { collection, getDocs, getDocsFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { SystemSettings } from '../types';
import { BACKUP_COLLECTIONS, SETTINGS_KEY } from './backupCollections';
import { saveFile } from './saveFile';

interface ExportBackupParams {
  uid: string;
  storeName: string;
  ownerName: string;
  businessType: string | null | undefined;
  settings: SystemSettings;
}

export interface BackupPayload {
  /** نص الملف كاملاً — نفس ما يُكتب في الملف المحلي وما يُرفع سحابياً */
  json: string;
  /** عدد وثائق كل مجموعة — يُعرض في قائمة اللقطات بلا تنزيلها */
  counts: Record<string, number>;
  /** 🔴 بُنيت من الذاكرة المحلية (تعذّر الخادم) ⇒ قد تكون ناقصة */
  fromCache: boolean;
  /** مجموع الوثائق — يُعرض للتاجر بدل «بنجاح» مجرّدة */
  totalDocs: number;
}

/**
 * 🔴 المصدر الموحّد لبناء محتوى النسخة — يشترك فيه **الملف المحلي واللقطة السحابية**.
 *
 * فصلُ البناء عن التنزيل مقصود: لو بنى كلٌّ منهما محتواه بنفسه لانحرفا يوماً — وهو
 * نفس الخطأ الذي وقع سابقاً حين كانت قائمة المجموعات مكتوبة مرتين فسقطت ميزتان كاملتان.
 *
 * يقرأ من الخادم أوّلاً؛ وعند تعذّره يُكمل من الكاش ويَسِم النسخة `fromCache` (انظر أدناه).
 */
export async function buildBackupPayload({
  uid, storeName, ownerName, businessType, settings,
}: ExportBackupParams): Promise<BackupPayload> {
  /**
   * 🔴 معرّف الوثيقة يُحفظ صراحةً، ولا يُعتمد على وجود حقل `id` داخل البيانات.
   *
   * الخلل الذي يُصلحه: `customers_public` لا تحوي حقل معرّف إطلاقاً (قاعدة الأمان تحصر
   * حقولها في الاسم فقط). فكانت تُصدَّر بلا معرّف، ثم تنهار كلها في وثيقة واحدة عند
   * الاستعادة — يفقد التاجر أسماء زبائنه التي يراها موظفوه، بلا أي رسالة خطأ.
   *
   * `d.id` أولاً ثم البيانات: لو كان في البيانات حقل `id` (كل المجموعات الأخرى) فهو
   * يطابق معرّف الوثيقة أصلاً، فلا يتغيّر شيء عمّا كان.
   */
  /**
   * 🔴 النسخة تُبنى من **الخادم** أوّلاً، لا من الذاكرة المحلية.
   *
   * كان `getDocs` وحده، والتعليق يقدّم القراءة من الكاش كميزة — وهي ميزة في كل مكانٍ
   * **إلا هنا**. النسخة الاحتياطية هي الأثر الوحيد الذي يجب أن يكون كماله مضموناً،
   * والذاكرة المحلية تحوي ما سبق مزامنته على **هذا الجهاز** لا كل ما في الحساب: جهازٌ
   * جديد، أو مجموعة لم تُفتح شاشتها قط، أو بيانات أقدم من نوافذ التحميل. فيخرج ملفٌ
   * ناقص باسم «نسخة احتياطية» ولا يُكتشف نقصه إلا يوم الاستعادة — يوم لا يملك غيره.
   *
   * ⚠️ ولا نعتمد `metadata.fromCache` حارساً: قِسْتُها في إصلاح الجرد الفعلي وتعود
   * `false` مع راوترٍ يعمل واشتراكٍ مقطوع. الإشارة الصادقة الوحيدة قراءةٌ تفرض الخادم.
   *
   * وحين يتعذّر الخادم لا نفشل: نُكمل من الكاش و**نَسِم النسخة** في ملفها وفي ما يُعرض،
   * فيقرّر التاجر على بيّنة بدل أن يُسلَّم ناقصاً باسم كامل.
   */
  let fromCache = false;
  const fetchAll = async (collName: string) => {
    const ref = collection(db, 'users', uid, collName);
    if (!fromCache) {
      try {
        const snap = await getDocsFromServer(ref);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch {
        fromCache = true;   // تعذّر الخادم مرّة ⇒ بقيّة المجموعات من الكاش بلا محاولات ضائعة
      }
    }
    const snap = await getDocs(ref);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };

  // 🔴 القائمة تُقرأ من مصدر واحد يشترك فيه التصدير والاستعادة. قبل ذلك كانت مكتوبة
  // مرتين فانحرفتا، فسقطت ميزتان كاملتان من النسخة الاحتياطية بلا أن يلاحظ أحد.
  // ⚠️ متسلسل لا متوازٍ: التوازي يجعل عدّة مجموعات تفشل معاً قبل أن يُرفع `fromCache`.
  const entries = Object.entries(BACKUP_COLLECTIONS);
  const fetched: Array<Array<Record<string, unknown>>> = [];
  for (const [, collName] of entries) fetched.push(await fetchAll(collName));

  const data: Record<string, string> = {};
  const counts: Record<string, number> = {};
  entries.forEach(([backupKey, collName], i) => {
    data[backupKey] = JSON.stringify(fetched[i]);
    counts[collName] = fetched[i].length;
  });
  data[SETTINGS_KEY] = JSON.stringify(settings);

  const backupData = {
    meta: {
      appName: 'رتب شغلك - نسخة الحساب الذكي',
      storeName,
      ownerName,
      businessType: businessType ?? 'general',
      exportDate: new Date().toISOString(),
      formatVersion: '2.7',
      /**
       * وسمٌ داخل الملف نفسه: `cache` تعني أنها بُنيت بلا وصولٍ للخادم وقد تكون ناقصة.
       * يُقرأ عند الاستعادة فيُحذَّر التاجر ولو فتح الملف بعد شهور.
       */
      source: fromCache ? 'cache' : 'server',
    },
    data,
  };

  const totalDocs = Object.values(counts).reduce((s, n) => s + n, 0);
  return { json: JSON.stringify(backupData, null, 2), counts, fromCache, totalDocs };
}

/**
 * ينزّل نسخة احتياطية كملف على جهاز المستخدم. يبني محتواه من المصدر الموحّد أعلاه.
 * يرمي عند الفشل ليتعامل المستدعي معه (لا ادّعاء نجاح كاذب).
 */
export async function exportBackup(params: ExportBackupParams): Promise<BackupPayload> {
  const payload = await buildBackupPayload(params);
  const jsonString = payload.json;
  const storeName = params.storeName;
  const blob = new Blob([jsonString], { type: 'application/json' });
  const dateStr = new Date().toLocaleDateString('ar-IQ').replace(/\//g, '-');
  const filename = `نسخة_رتب_شغلك_${(storeName || 'المتجر').replace(/\s+/g, '_')}_${dateStr}.json`;

  /**
   * 🔴 **تُنتظر ولا تُطلَق وتُنسى.** الدالة توثّق أنها «ترمي عند الفشل ليتعامل
   * المستدعي معه (لا ادّعاء نجاح كاذب)» — والنسخة الاحتياطية أخطر ما يُدَّعى
   * نجاحه كذباً: يطمئنّ التاجر أن عنده نسخة، ولا يكتشف العكس إلا يوم يحتاجها.
   *
   * و`saveFile` تختار المسار حسب المنصّة: تنزيلٌ على الكمبيوتر، وورقةُ مشاركة
   * على الهاتف — فـ`<a download>` لا يعمل داخل WebView.
   */
  await saveFile(blob, filename);
  return payload;
}

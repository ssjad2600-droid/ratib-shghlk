import { doc, setDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';

/**
 * رصد الأخطاء عند الزبائن — العين التي كانت مفقودة.
 *
 * المشكلة: تاجر تنهار عنده شاشة فيرى بياضاً، ويتصل يقول «البرنامج خربان». لا نعرف
 * أي شاشة ولا أي خطأ ولا كم زبوناً آخر يعاني منه صامتاً.
 *
 * 🔒 الخصوصية أولاً — قاعدة غير قابلة للتفاوض:
 * لا يُرسَل أي بيان تجاري إطلاقاً. لا أسماء زبائن، لا مبالغ، لا أرقام هواتف، لا أصناف.
 * يُرسَل فقط: نص الخطأ، أثر التنفيذ، اسم الشاشة، معرّف الحساب، والوقت. وقبل الإرسال
 * يمرّ النص على منقٍّ يمسح ما قد يتسرّب عرضاً (أرقام طويلة، بريد، مسارات ويندوز).
 *
 * وثلاثة ضوابط تمنع التقرير نفسه من أن يصير مشكلة:
 *  · تكرار: نفس الخطأ يُرسَل مرة واحدة لكل جلسة (لا ألف وثيقة من حلقة رندر).
 *  · سقف: ٥ تقارير كحدّ أقصى للجلسة الواحدة.
 *  · إطلاق ونسيان: الكتابة لا تُنتظَر ولا ترمي أبداً — خطأ في التبليغ لا يعطّل البرنامج.
 */

const MAX_PER_SESSION = 5;
const MAX_STACK_CHARS = 1200;
const MAX_MESSAGE_CHARS = 400;

/**
 * بوابة الإغراق — دالة خالصة قابلة للاختبار بلا شبكة ولا مصادقة.
 * `allow` تُرجع true **وتسجّل** في نفس النداء، فالتكرار والسقف يُختبران فعلياً
 * لا بالنيّة. فصلها عن الإرسال مقصود: منطق الحماية أهمّ من أن يُترك بلا اختبار.
 */
export function createFloodGate(max: number) {
  const seenSigs = new Set<string>();
  let count = 0;
  return {
    allow(signature: string): boolean {
      if (count >= max) return false;
      if (seenSigs.has(signature)) return false;
      seenSigs.add(signature);
      count += 1;
      return true;
    },
    reset() { seenSigs.clear(); count = 0; },
    get sent() { return count; },
  };
}

const gate = createFloodGate(MAX_PER_SESSION);

/**
 * ينقّي النص من أي بيان قد يكون شخصياً أو تجارياً.
 * الترتيب مقصود: البريد أولاً (يحوي نقاطاً)، ثم المسارات، ثم الأرقام الطويلة.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[بريد]')
    // مسارات الملفات بكل صيغها. الصيغة ذات الشرطة **الأمامية** هي الشائعة فعلياً في آثار
    // التنفيذ (Electron والمتصفح: file:///C:/Users/…)، وإغفالها كان يسرّب اسم مستخدم ويندوز.
    //
    // ⚠️ `\b` قبل حرف القرص ضرورية: بدونها يطابق النمط `p:/` داخل `http://` فيمسخ كل
    // عناوين الوحدات في الأثر («htt[مسار]») ويُتلف معلومة الملف والسطر — أي يقتل فائدة
    // التقرير كله. الحدّ يمنع ذلك لأن `t` و`p` كلاهما حرف كلمة فلا حدّ بينهما.
    .replace(/(?:file:\/\/\/)?\b[A-Za-z]:[\\/][^\s)'"]+/g, '[مسار]')
    .replace(/(?:file:\/\/)?\/(?:home|Users|root)\/[^\s)'"]+/g, '[مسار]')
    .replace(/\b\d{7,}\b/g, '[رقم]')            // هواتف، مبالغ كبيرة، معرّفات
    .replace(/\b0\d{9,10}\b/g, '[رقم]');
}

/** توقيع الخطأ للتكرار — أول سطرين من الأثر يكفيان لتمييزه. */
const signatureOf = (message: string, stack: string, screen: string): string =>
  `${screen}|${message}|${stack.split('\n').slice(0, 2).join('|')}`;

export interface ErrorReport {
  id: string;
  message: string;
  stack: string;
  /** الشاشة أو السياق الذي وقع فيه الخطأ */
  screen: string;
  /** 'render' من ErrorBoundary · 'window' خطأ عام · 'promise' وعد مرفوض */
  source: 'render' | 'window' | 'promise';
  uid: string;
  createdAt: number;
  /** نسخة البرنامج — لمعرفة هل الخطأ في إصدار قديم */
  appVersion: string;
  userAgent: string;
  online: boolean;
}

/** يُقرأ من متغيّر البناء إن وُجد، وإلا 'dev'. */
const APP_VERSION: string =
  (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev');

/**
 * يبني التقرير المنقّى. مفصول عن الإرسال ليكون قابلاً للاختبار بلا شبكة.
 */
export function buildReport(
  error: unknown,
  screen: string,
  source: ErrorReport['source'],
  uid: string,
  now = Date.now(),
): ErrorReport {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    message: sanitize(err.message || 'خطأ غير معروف').slice(0, MAX_MESSAGE_CHARS),
    stack: sanitize(err.stack || '').slice(0, MAX_STACK_CHARS),
    screen: screen || 'غير معروف',
    source,
    uid,
    createdAt: now,
    appVersion: APP_VERSION,
    userAgent: (navigator.userAgent || '').slice(0, 200),
    online: navigator.onLine,
  };
}

/** إعادة ضبط بوابة الجلسة — للاختبارات فقط. */
export function __resetReporter() { gate.reset(); }

/**
 * يبلّغ عن خطأ. إطلاق ونسيان: لا ينتظر ولا يرمي مهما حدث.
 * المستخدم غير المسجَّل لا يُبلَّغ عنه (لا هوية ولا صلاحية كتابة).
 */
export function reportError(error: unknown, screen: string, source: ErrorReport['source'] = 'render'): void {
  try {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const report = buildReport(error, screen, source, uid);
    // البوابة تفحص وتسجّل معاً — لا فجوة بين القرار والتسجيل
    if (!gate.allow(signatureOf(report.message, report.stack, report.screen))) return;

    // مجموعة عليا: تُكتب من أي حساب، ولا يقرأها إلا المطوّر (تفرضه قواعد Firestore).
    setDoc(doc(db, 'errorReports', report.id), report).catch(() => {
      /* تعذّر الإرسال (أوفلاين/صلاحيات) — لا نُصعّد: تقرير خطأ لا يجوز أن يصير خطأً */
    });
  } catch {
    /* المبلِّغ نفسه لا يرمي أبداً */
  }
}

/**
 * يربط الملتقطات العامة: أخطاء غير ملتقطة، ووعود مرفوضة.
 * يُستدعى مرة واحدة عند إقلاع التطبيق.
 */
export function installGlobalErrorHandlers(getScreen: () => string): () => void {
  const onError = (e: ErrorEvent) => reportError(e.error ?? e.message, getScreen(), 'window');
  const onRejection = (e: PromiseRejectionEvent) => reportError(e.reason, getScreen(), 'promise');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

declare const __APP_VERSION__: string | undefined;

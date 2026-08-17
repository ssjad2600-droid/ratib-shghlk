import {
  collection, doc, getDoc, getDocs, writeBatch, query, orderBy, Bytes,
} from 'firebase/firestore';
import { db } from '../firebase';

/**
 * النسخ الاحتياطي السحابي — لقطات محفوظة داخل حساب المالك نفسه.
 *
 * ⚠️ الوعد الذي كان كاذباً: زر «مزامنة سحابية» كان يسجّل طابعاً زمنياً ويقول «تمت» بلا
 * أن ينسخ حرفاً. وعدٌ لا يُوفى أسوأ من ميزة غائبة، لأن التاجر يبني عليه أماناً لا وجود له.
 *
 * 🔴 ما الذي يحميه هذا فعلاً؟
 * Firestore يحمي بياناتك من تلف الجهاز وسرقته — فهي في السحابة أصلاً. لكنه **لا يحميك
 * ممّا يفعله المستخدم بنفسه**: حذف زبون بالخطأ، استيراد جماعي يمسح فوق الصحيح، استعادة
 * ملف قديم. الحذف في Firestore نهائي ولا رجعة زمنية فيه.
 * لذلك اللقطة الدورية هي الحماية الوحيدة من أخطر مصدر خطر: اليد البشرية.
 *
 * 🔴 لماذا داخل Firestore لا في خدمة تخزين منفصلة؟
 *  · تعمل فوراً بلا خطة مدفوعة ولا تفعيل خدمة ولا ملف قواعد ثانٍ يُنشر.
 *  · تُغطّيها قواعد الأمان القائمة (شجرة المالك) — لا ثغرة جديدة.
 *  · تعمل أوفلاين: الكتابة تُصطفّ وتُرسل عند عودة الشبكة، كبقية البرنامج.
 *
 * 🔴 وكيف لا تلتهم مساحتك وأنت تبيع لمئة محل؟
 *  · **ضغط gzip** قبل الحفظ — النص يتقلّص نحو عشرة أضعاف.
 *  · تخزين ثنائي (Bytes) لا نصّي — يتفادى تضخّم base64 بالثلث.
 *  · **تقليم تلقائي**: يُحتفظ بآخر N لقطات فقط، وما قبلها يُحذف مع أجزائه.
 */

/** حدّ وثيقة Firestore ١ ميغابايت — نبقى دونه بهامش أمان مريح. */
const CHUNK_BYTES = 700 * 1024;
/** كم لقطة تُحفظ قبل تقليم الأقدم. */
export const DEFAULT_KEEP = 5;

export const SNAPSHOTS_COLL = 'cloud_backups';
export const CHUNKS_COLL = 'cloud_backup_chunks';

export interface CloudSnapshotMeta {
  id: string;
  createdAt: number;
  /** حجم النص قبل الضغط (بايت) — لعرضه للمستخدم */
  rawBytes: number;
  storedBytes: number;
  chunkCount: number;
  compressed: boolean;
  /** عدّادات سريعة تُعرض في القائمة بلا تنزيل اللقطة */
  counts: Record<string, number>;
  appVersion: string;
  createdByName: string;
}

// ---------------------------------------------------------------- الضغط

const hasCompression = () =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function gzip(text: string): Promise<Uint8Array> {
  const input = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(input).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const input = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(input).text();
}

// ---------------------------------------------------------------- إنشاء لقطة

export interface CreateSnapshotParams {
  uid: string;
  /** نص ملف النسخة الكامل — نفس ما يُصدَّر إلى ملف، فالمصدر واحد */
  json: string;
  counts: Record<string, number>;
  appVersion: string;
  createdByName: string;
  keep?: number;
}

/**
 * يحفظ لقطة سحابية ويقلّم الأقدم. يرمي عند الفشل ليتعامل المستدعي معه
 * (لا ادّعاء نجاح كاذب — الدرس المستفاد من الزر القديم).
 */
export async function createCloudSnapshot({
  uid, json, counts, appVersion, createdByName, keep = DEFAULT_KEEP,
}: CreateSnapshotParams): Promise<CloudSnapshotMeta> {
  const rawBytes = new Blob([json]).size;
  const compressed = hasCompression();
  const payload: Uint8Array = compressed
    ? await gzip(json)
    : new TextEncoder().encode(json);

  const id = `snap_${Date.now()}`;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += CHUNK_BYTES) {
    chunks.push(payload.slice(i, i + CHUNK_BYTES));
  }

  const meta: CloudSnapshotMeta = {
    id,
    createdAt: Date.now(),
    rawBytes,
    storedBytes: payload.length,
    chunkCount: chunks.length,
    compressed,
    counts,
    appVersion,
    createdByName,
  };

  // الأجزاء أولاً ثم البيان الوصفي في نفس الدفعة الذرّية: لا يظهر بيان بلا أجزائه
  const batch = writeBatch(db);
  chunks.forEach((c, i) => {
    batch.set(doc(db, 'users', uid, CHUNKS_COLL, `${id}_${i}`), {
      snapshotId: id, index: i, data: Bytes.fromUint8Array(c),
    });
  });
  batch.set(doc(db, 'users', uid, SNAPSHOTS_COLL, id), meta);
  await batch.commit();

  await pruneCloudSnapshots(uid, keep);
  return meta;
}

// ---------------------------------------------------------------- قراءة

export async function listCloudSnapshots(uid: string): Promise<CloudSnapshotMeta[]> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, SNAPSHOTS_COLL), orderBy('createdAt', 'desc')),
  );
  return snap.docs.map(d => d.data() as CloudSnapshotMeta);
}

/** يُعيد بناء نص الملف من أجزائه. يرمي إن نقص جزء — لا يُعيد نسخة ناقصة صامتة. */
export async function readCloudSnapshot(uid: string, id: string): Promise<string> {
  const metaDoc = await getDoc(doc(db, 'users', uid, SNAPSHOTS_COLL, id));
  if (!metaDoc.exists()) throw new Error('اللقطة غير موجودة');
  const meta = metaDoc.data() as CloudSnapshotMeta;

  const parts: Uint8Array[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const c = await getDoc(doc(db, 'users', uid, CHUNKS_COLL, `${id}_${i}`));
    if (!c.exists()) throw new Error(`جزء ناقص من النسخة (${i + 1} من ${meta.chunkCount}) — لا تُستعاد نسخة ناقصة`);
    parts.push((c.data().data as Bytes).toUint8Array());
  }

  const total = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { merged.set(p, offset); offset += p.length; }

  if (meta.storedBytes && total !== meta.storedBytes) {
    throw new Error('حجم النسخة لا يطابق المسجَّل — الملف تالف، لن تُستعاد');
  }

  return meta.compressed ? await gunzip(merged) : new TextDecoder().decode(merged);
}

// ---------------------------------------------------------------- تقليم

/** يحذف اللقطات الأقدم مع كل أجزائها — يمنع تراكم المساحة بلا حدّ. */
export async function pruneCloudSnapshots(uid: string, keep = DEFAULT_KEEP): Promise<number> {
  const all = await listCloudSnapshots(uid);
  const old = all.slice(keep);
  if (old.length === 0) return 0;

  let batch = writeBatch(db);
  let ops = 0;
  const flush = async () => { await batch.commit(); batch = writeBatch(db); ops = 0; };
  for (const s of old) {
    for (let i = 0; i < s.chunkCount; i++) {
      batch.delete(doc(db, 'users', uid, CHUNKS_COLL, `${s.id}_${i}`));
      if (++ops >= 450) await flush();
    }
    batch.delete(doc(db, 'users', uid, SNAPSHOTS_COLL, s.id));
    if (++ops >= 450) await flush();
  }
  if (ops > 0) await batch.commit();
  return old.length;
}

/** حذف لقطة بعينها (بطلب صريح من المالك). */
export async function deleteCloudSnapshot(uid: string, id: string): Promise<void> {
  const metaDoc = await getDoc(doc(db, 'users', uid, SNAPSHOTS_COLL, id));
  const chunkCount = metaDoc.exists() ? (metaDoc.data() as CloudSnapshotMeta).chunkCount : 0;
  const batch = writeBatch(db);
  for (let i = 0; i < chunkCount; i++) batch.delete(doc(db, 'users', uid, CHUNKS_COLL, `${id}_${i}`));
  batch.delete(doc(db, 'users', uid, SNAPSHOTS_COLL, id));
  await batch.commit();
}

/** عرض الحجم بصيغة مقروءة. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} كيلوبايت`;
  return `${(n / (1024 * 1024)).toFixed(2)} ميغابايت`;
}

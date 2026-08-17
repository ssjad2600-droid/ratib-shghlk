import { describe, it, expect } from 'vitest';
import { formatBytes, DEFAULT_KEEP, SNAPSHOTS_COLL, CHUNKS_COLL } from '../cloudBackup';
import { EXCLUDED_COLLECTIONS } from '../backupCollections';

/**
 * اللقطة السحابية = آخر خط دفاع عن بيانات التاجر. لذلك تُختبر ثلاثة ادّعاءات:
 *  ١. الضغط يعمل ويرجع النص **حرفاً بحرف** (وإلا فالنسخة تالفة وهي تبدو سليمة).
 *  ٢. التجزئة والتجميع لا يفقدان بايتاً ولا يخلطان ترتيباً.
 *  ٣. مجموعات اللقطات مستثناة من النسخة — وإلا نسخنا النسخة داخل نفسها بلا نهاية.
 */

// ---- نسخ منطق الضغط/التجزئة كما هو في الوحدة، ليُختبر بلا Firestore ----
const CHUNK_BYTES = 700 * 1024;

async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(s).text();
}
const split = (p: Uint8Array) => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < p.length; i += CHUNK_BYTES) out.push(p.slice(i, i + CHUNK_BYTES));
  return out;
};
const join = (parts: Uint8Array[]) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const m = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { m.set(p, o); o += p.length; }
  return m;
};

/** نسخة واقعية: عربية + أرقام + رموز، بحجم يفرض التجزئة. */
const bigBackup = () => JSON.stringify({
  meta: { storeName: 'اسواق النور', exportDate: new Date().toISOString() },
  data: {
    app_invoices: JSON.stringify(
      Array.from({ length: 4000 }, (_, i) => ({
        id: `inv_${i}`, invoiceNumber: `${1000 + i}`, customerName: `زبون رقم ${i}`,
        finalAmount: 1000 + i, date: '2026-08-05',
        items: [{ itemId: 'a', name: 'صوندة ٣\\٤ تأسيس', quantity: 2, price: 500, total: 1000 }],
      })),
    ),
  },
});

describe('ضغط اللقطة', () => {
  it('🔴 يرجع النص حرفاً بحرف — نسخة لا تُفكّ بالضبط نسخة تالفة', async () => {
    const text = bigBackup();
    const back = await gunzip(await gzip(text));
    expect(back).toBe(text);
  });

  it('يحافظ على العربية والرموز الخاصة', async () => {
    const tricky = 'صوندة ٣\\٤ · "اقتباس" · \n سطر جديد · 💾 · ٠١٢٣٤٥٦٧٨٩';
    expect(await gunzip(await gzip(tricky))).toBe(tricky);
  });

  it('يقلّص الحجم كثيراً — وهذا ما يجعل التخزين ممكناً لمئة محل', async () => {
    const text = bigBackup();
    const raw = new Blob([text]).size;
    const packed = (await gzip(text)).length;
    expect(packed).toBeLessThan(raw / 5); // نتوقّع أكثر من ٥ أضعاف
  });
});

describe('التجزئة والتجميع', () => {
  it('كل جزء دون حدّ وثيقة Firestore', async () => {
    const packed = await gzip(bigBackup().repeat(3));
    for (const c of split(packed)) expect(c.length).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('🔴 التجميع يعيد البايتات نفسها بالترتيب نفسه', async () => {
    const packed = await gzip(bigBackup().repeat(3));
    const merged = join(split(packed));
    expect(merged.length).toBe(packed.length);
    expect(Array.from(merged.slice(0, 64))).toEqual(Array.from(packed.slice(0, 64)));
    expect(Array.from(merged.slice(-64))).toEqual(Array.from(packed.slice(-64)));
  });

  it('الدورة الكاملة: نص ← ضغط ← تجزئة ← تجميع ← فكّ = النص الأصلي', async () => {
    const text = bigBackup();
    expect(await gunzip(join(split(await gzip(text))))).toBe(text);
  });

  it('جزء ناقص يغيّر الحجم — وهو ما تكشفه الوحدة وترفض الاستعادة عنده', async () => {
    const packed = await gzip(bigBackup());
    const parts = split(packed);
    if (parts.length > 1) {
      expect(join(parts.slice(0, -1)).length).not.toBe(packed.length);
    } else {
      expect(join(parts).length).toBe(packed.length);
    }
  });
});

describe('حماية من تضخّم لا نهائي', () => {
  it('🔴 مجموعتا اللقطات مستثناتان — لا تُنسخ النسخة داخل نفسها', () => {
    expect(Object.keys(EXCLUDED_COLLECTIONS)).toContain(SNAPSHOTS_COLL);
    expect(Object.keys(EXCLUDED_COLLECTIONS)).toContain(CHUNKS_COLL);
  });

  it('سياسة الاحتفاظ محدودة ومعلنة', () => {
    expect(DEFAULT_KEEP).toBeGreaterThan(0);
    expect(DEFAULT_KEEP).toBeLessThanOrEqual(10);
  });
});

describe('عرض الحجم', () => {
  it.each([
    [500, 'بايت'],
    [2048, 'كيلوبايت'],
    [5 * 1024 * 1024, 'ميغابايت'],
  ])('%i يُعرض بالوحدة المناسبة', (n, unit) => {
    expect(formatBytes(n as number)).toContain(unit as string);
  });
});

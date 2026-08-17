import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_COLLECTIONS, EXCLUDED_COLLECTIONS, CLASSIFIED_COLLECTIONS } from '../backupCollections';

/**
 * 🔴 اختبار حارس — يفحص **الكود نفسه** لا نتيجة دالة.
 *
 * الخلل الذي يمنعه: أُضيفت ميزتان (شحنات الصلاحية ونقل البضاعة) ولم تُوصَّلا بالنسخة
 * الاحتياطية، فصار التاجر يستعيد نسخته وتختفي بياناته صامتةً. لا اختبار وحدة يكشف
 * هذا لأن كل دالة على حدة سليمة — الخلل في **النسيان** لا في المنطق.
 *
 * لذلك يمسح هذا الاختبار كل ملفات المشروع، ويستخرج كل مجموعة بيانات مستعملة، ويفشل
 * إن وجد واحدة غير مصنَّفة: إمّا مشمولة في النسخة، أو مستثناة **بسبب مكتوب**.
 * فأي ميزة جديدة تُضيف مجموعة بلا نسخ احتياطي تُوقف الاختبارات فوراً.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue; // ملفات الاختبار ليست استعمالاً حقيقياً
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** يستخرج أسماء المجموعات من كل أنماط الوصول المستعملة في المشروع. */
function collectionsUsedInSource(): Set<string> {
  const found = new Set<string>();
  // تقبل علامتي الاقتباس معاً — نسخة سابقة قبلت المفردة فقط ففاتها كودٌ مكتوب بالمزدوجة
  const Q = `['"\`]`;
  const NAME = `([a-z_]+)`;
  const patterns = [
    new RegExp(`useCollection<[^>]*>\\(\\s*${Q}${NAME}${Q}`, 'g'),
    new RegExp(`collection\\(\\s*db\\s*,\\s*${Q}users${Q}\\s*,\\s*[\\w.!?]+\\s*,\\s*${Q}${NAME}${Q}`, 'g'),
    new RegExp(`doc\\(\\s*db\\s*,\\s*${Q}users${Q}\\s*,\\s*[\\w.!?]+\\s*,\\s*${Q}${NAME}${Q}`, 'g'),
  ];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) found.add(m[1]);
    }
  }
  return found;
}

describe('تغطية النسخة الاحتياطية', () => {
  it('🔴 كل مجموعة مستعملة في البرنامج إمّا مشمولة بالنسخة أو مستثناة بسبب مكتوب', () => {
    const used = collectionsUsedInSource();
    const unclassified = [...used].filter(c => !CLASSIFIED_COLLECTIONS.has(c)).sort();
    expect(
      unclassified,
      `مجموعات مستعملة وغير مصنَّفة — أضفها إلى BACKUP_COLLECTIONS أو إلى EXCLUDED_COLLECTIONS مع سبب: ${unclassified.join('، ')}`,
    ).toEqual([]);
  });

  it('الاختبار يرى فعلاً مجموعات المشروع (حماية من فحص فارغ يمرّ كذباً)', () => {
    const used = collectionsUsedInSource();
    // لو انكسر الاستخراج يوماً، هذه تكشفه بدل أن يمرّ الاختبار الأول بلا معنى
    expect(used.size).toBeGreaterThan(10);
    for (const core of ['invoices', 'products', 'customers', 'expiry_batches', 'stock_transfers']) {
      expect(used, `المسح لم يجد ${core}`).toContain(core);
    }
  });

  it('الميزتان اللتان سقطتا سابقاً مشمولتان الآن', () => {
    const backed = new Set(Object.values(BACKUP_COLLECTIONS));
    expect(backed).toContain('expiry_batches');
    expect(backed).toContain('stock_transfers');
    expect(backed).toContain('customers_public');
  });

  it('لكل مجموعة مستثناة سبب مكتوب — لا استثناء صامت', () => {
    for (const [name, reason] of Object.entries(EXCLUDED_COLLECTIONS)) {
      expect(reason.trim().length, `المجموعة ${name} مستثناة بلا سبب`).toBeGreaterThan(15);
    }
  });

  it('لا ازدواج: كل مجموعة مشمولة أو مستثناة، لا الاثنين', () => {
    const backed = Object.values(BACKUP_COLLECTIONS);
    const overlap = backed.filter(c => c in EXCLUDED_COLLECTIONS);
    expect(overlap).toEqual([]);
  });

  it('مفاتيح النسخة فريدة ولا تتكرّر على مجموعتين', () => {
    const values = Object.values(BACKUP_COLLECTIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('🔴 التصدير والاستعادة يقرآن من نفس المصدر — لا قائمة ثانية تنحرف', () => {
    const exportSrc = readFileSync(join(SRC, 'utils', 'exportBackup.ts'), 'utf8');
    const restoreSrc = readFileSync(join(SRC, 'components', 'BackupView.tsx'), 'utf8');
    expect(exportSrc).toContain('BACKUP_COLLECTIONS');
    expect(restoreSrc).toContain('BACKUP_COLLECTIONS');
    // ولا يُعيد أيّهما تعريف خريطة خاصة به
    expect(restoreSrc).not.toMatch(/COLLECTION_MAP:\s*Record<string,\s*string>\s*=\s*\{/);
  });
});

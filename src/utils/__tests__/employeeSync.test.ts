import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPayloads, disabledPayloads, branchPayloads, SYNC_FAILED,
} from '../employeeSync';

/**
 * 🔴 حالة صلاحية الموظف تسكن وثيقتين، وكانتا تُكتبان بنداءين مستقلَّين.
 *
 *   · `users/{owner}/employees/{uid}` ⟵ تقرؤه **القواعد**. الحقيقة الأمنية.
 *   · `employeeIndex/{uid}`           ⟵ تقرؤه **جلسة الموظف**. ما تراه الواجهة.
 *
 * فنجاح واحدة وفشل الأخرى يفصل الأمن عن الواجهة بلا إشارة — وأخطر اتجاهاته أن تقول
 * الشاشة «مُعطَّل» بينما القواعد تسمح له بالبيع.
 */

describe('حمولتا الإنشاء', () => {
  const p = createPayloads({
    uid: 'emp1', ownerUid: 'own1', name: 'أحمد', email: 'a@b.c',
    addedAt: '2026-08-17T00:00:00.000Z', branchId: 'branch_2', branchName: 'فرع البصرة',
  });

  it('سجل المالك يحمل ما تحتاجه القواعد والعرض', () => {
    expect(p.employee).toEqual({
      id: 'emp1', name: 'أحمد', email: 'a@b.c',
      addedAt: '2026-08-17T00:00:00.000Z', disabled: false, branchId: 'branch_2',
    });
  });

  it('الفهرس يحمل ownerUid — وبدونه ترفضه القاعدة', () => {
    expect(p.index.ownerUid).toBe('own1');
  });

  it('🔴 الفهرس يحمل اسم الفرع لأن مجموعة branches محجوبة عن الموظف', () => {
    expect(p.index.branchName).toBe('فرع البصرة');
    expect(p.index.branchId).toBe('branch_2');
  });

  it('الحقول المالية أو الحسّاسة لا تتسرّب إلى الفهرس', () => {
    expect(p.index).not.toHaveProperty('email');
    expect(Object.keys(p.index).sort()).toEqual(['branchId', 'branchName', 'disabled', 'name', 'ownerUid']);
  });
});

describe('🔴 الحقل الأمني يُكتب في المرجعين بنفس القيمة', () => {
  it('التعطيل ⟵ disabled=true في الوثيقتين', () => {
    const p = disabledPayloads('own1', true);
    expect(p.employee.disabled).toBe(true);
    expect(p.index.disabled).toBe(true);
    expect(
      p.employee.disabled,
      'اختلاف القيمتين هو عين العلّة: القواعد تسمح والواجهة تمنع أو العكس',
    ).toBe(p.index.disabled);
  });

  it('التفعيل ⟵ disabled=false في الوثيقتين', () => {
    const p = disabledPayloads('own1', false);
    expect(p.employee.disabled).toBe(false);
    expect(p.index.disabled).toBe(false);
  });

  it('🔧 حمولة الفهرس تحمل ownerUid فتشفي فهرساً غائباً بدل أن تُرفض', () => {
    expect(
      disabledPayloads('own1', true).index.ownerUid,
      'set/merge على فهرس غائب يُنشئه — والقاعدة تشترط ownerUid وإلا رُفض وسقط الشفاء',
    ).toBe('own1');
  });

  it('لا تمسّ حمولة التعطيل الفرع ولا الاسم', () => {
    expect(Object.keys(disabledPayloads('own1', true).employee)).toEqual(['disabled']);
  });
});

describe('نقل الفرع', () => {
  const p = branchPayloads('own1', 'branch_9', 'المخزن');

  it('الفرع يُكتب في المرجعين', () => {
    expect(p.employee.branchId).toBe('branch_9');
    expect(p.index.branchId).toBe('branch_9');
  });

  it('والاسم في الفهرس وحده (المالك يقرأ branches مباشرة)', () => {
    expect(p.index.branchName).toBe('المخزن');
    expect(p.employee).not.toHaveProperty('branchName');
  });

  it('وownerUid حاضر للقاعدة وللشفاء', () => {
    expect(p.index.ownerUid).toBe('own1');
  });
});

describe('رسالة الفشل', () => {
  it('تقول صراحةً إن شيئاً لم يُكتب — وإلا ظنّ التاجر أن نصف العملية تمّ', () => {
    const m = SYNC_FAILED('تعطيل حساب «أحمد»');
    expect(m).toMatch(/تعطيل حساب «أحمد»/);
    expect(m).toMatch(/لم يُحفظ أي تغيير/);
    expect(m).toMatch(/أعد المحاولة/);
  });
});

/**
 * 🔴 حارس: الوثيقتان لا تُكتبان إلا معاً، وفي دفعة ذرّية.
 */
describe('حارس: تزامن وثيقتَي الموظف', () => {
  const root = join(process.cwd(), 'src');
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const view = strip(readFileSync(join(root, 'components', 'EmployeeManagement.tsx'), 'utf8'));
  const util = strip(readFileSync(join(root, 'utils', 'employeeSync.ts'), 'utf8'));

  it('المسح يرى الملفات فعلاً', () => {
    expect(view).toContain('toggleDisabled');
    expect(view).toContain('handleDelete');
    expect(util).toContain('stageEmployeeWrite');
  });

  it('🔴 لا كتابة مفردة على أيٍّ من الوثيقتين في الشاشة', () => {
    expect(
      /(setDoc|updateDoc|deleteDoc)\s*\(\s*doc\(db,\s*'employeeIndex'/.test(view),
      'كتابة الفهرس وحده تُعيد الانفصال الذي أُصلح',
    ).toBe(false);
    expect(
      /(setDoc|updateDoc|deleteDoc)\s*\(\s*doc\(db,\s*'users',\s*ownerUid,\s*'employees'/.test(view),
      'كتابة سجل المالك وحده تُعيد الانفصال الذي أُصلح',
    ).toBe(false);
  });

  it('🔴 كل العمليات الأربع تمرّ من الدفعة الذرّية', () => {
    expect(/stageEmployeeWrite\(batch/.test(view)).toBe(true);
    expect(/stageEmployeeDelete\(batch/.test(view)).toBe(true);
    // أربع عمليات ⟵ أربع دفعات
    expect((view.match(/writeBatch\(db\)/g) ?? []).length).toBe(4);
    expect((view.match(/batch\.commit\(\)/g) ?? []).length).toBe(4);
  });

  it('🔧 المحرّك يستعمل set/merge لا update — فلا تسقط الدفعة على فهرس غائب', () => {
    expect(
      /batch\.set\([\s\S]{0,120}\{ merge: true \}\)/.test(util),
      'update() يفشل على وثيقة غير موجودة ويُسقط الدفعة كلها ⟵ موظف لا يمكن تعطيله أبداً',
    ).toBe(true);
    expect(
      /batch\.update\(/.test(util),
      'update يمنع شفاء الانفصال القائم من قبل الإصلاح',
    ).toBe(false);
  });

  it('🔴 ولا تُصدَّر دالة تكتب وثيقة واحدة وحدها', () => {
    const exported = [...util.matchAll(/export function (\w+)/g)].map(m => m[1]);
    expect(exported).toContain('stageEmployeeWrite');
    expect(exported).toContain('stageEmployeeDelete');
    expect(
      exported.some(n => /^(stageIndex|stageEmployeeOnly|writeIndex)/.test(n)),
      'وجود طريق يكتب واحدة وحدها يُبطل الحارس — غياب الطريق أقوى من التذكير به',
    ).toBe(false);
  });

  it('🔴 فشل الدفعة يُعرَض للتاجر لا للطرفية وحدها', () => {
    expect(/setActionError\(SYNC_FAILED\(/.test(view)).toBe(true);
    expect(
      /\{actionError && \(/.test(view),
      'رسالة تُخزَّن ولا تُعرض = صمت آخر',
    ).toBe(true);
  });
});

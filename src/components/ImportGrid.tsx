import React, { useRef, useState } from 'react';
import { Trash2, Plus, Eraser } from 'lucide-react';
import { GridColumn } from '../utils/bulkImport';
import NumberInput from './NumberInput';
import { toArabicDigits } from '../utils/arabicFormatters';

/**
 * جدولٌ معنون يُملأ **داخل البرنامج** — بديل رحلة الملف.
 *
 * 🔴 لماذا وُجد؟ لأن إدخال مئة صنف كان يمرّ بثمانِ خطوات: نزّل القالب، جِده في
 * مجلّد التنزيلات، افتحه في Excel، املأه، «حفظ باسم»، اختر الترميز الصحيح،
 * ارجع للبرنامج، ارفعه. الجدول واحدةٌ من الثماني — والسبع الأخريات خدمةٌ للملف
 * لا للتاجر. وكل واحدةٍ منها بابُ فشلٍ عالجناه بسطر شرحٍ حتى صار الشرح أطول
 * من العمل.
 *
 * فالتبسيط بالحذف لا بالإيضاح: يُكتب هنا مباشرةً، أو تُلصق قائمةٌ جاهزة من
 * Excel بضغطة واحدة. ولا تنزيل ولا حفظ باسم ولا ترميز ولا بحثٌ عن ملف.
 *
 * والمخرَج **نفس شكل مخرَج قراءة الملف** — كائنات مفاتيحها أسماء الأعمدة — فيمرّ
 * على `parseProductRows` نفسها بلا تعديل: تحقّقٌ واحد ومعاينةٌ واحدة للمسارين.
 */

interface Props {
  columns: GridColumn[];
  /** يُستدعى عند كل تغيير — الصفوف الفارغة تماماً مُسقَطة سلفاً */
  onChange: (rows: Array<Record<string, string>>) => void;
}

const START_ROWS = 6;

const emptyRow = (n: number): string[] => new Array(n).fill('');

export default function ImportGrid({ columns, onChange }: Props) {
  const [cells, setCells] = useState<string[][]>(
    () => Array.from({ length: START_ROWS }, () => emptyRow(columns.length)),
  );
  const focus = useRef<{ r: number; c: number }>({ r: 0, c: 0 });

  /** يُخرج الصفوف غير الفارغة بشكل `Record` — نفس مخرَج `csvToObjects`. */
  const publish = (next: string[][]) => {
    setCells(next);
    const rows = next
      .filter(row => row.some(v => v.trim() !== ''))
      .map(row => Object.fromEntries(columns.map((col, i) => [col.header, row[i] ?? ''])));
    onChange(rows);
  };

  /** يضمن وجود صفٍّ فارغ في النهاية دائماً — فلا يبحث المستخدم عن زرّ «أضف». */
  const withTrailingBlank = (rows: string[][]): string[][] => {
    const last = rows[rows.length - 1];
    if (last && last.every(v => v.trim() === '')) return rows;
    return [...rows, emptyRow(columns.length)];
  };

  const setCell = (r: number, c: number, value: string) => {
    const next = cells.map(row => [...row]);
    while (next.length <= r) next.push(emptyRow(columns.length));
    next[r][c] = value;
    publish(withTrailingBlank(next));
  };

  /**
   * 🔴 لصقُ Excel: الحافظة تحمل أعمدةً مفصولة بـTab وأسطراً بـ`\n`.
   *
   * وأول سطرٍ قد يكون الترويسة (ينسخ التاجر الجدول كاملاً عادةً) — فنتخطّاه إن
   * طابق عناوين أعمدتنا. وإلا استُورد «اسم المنتج» منتجاً اسمه «اسم المنتج».
   */
  const handlePaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // لصقُ خانةٍ واحدة: السلوك الطبيعي

    e.preventDefault();
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
    let grid = lines.map(l => l.split('\t'));

    const headerNames = columns.map(c => c.header.trim());
    const labelNames = columns.map(c => c.label.trim());
    const first = grid[0].map(v => v.trim());
    const looksLikeHeader = first.some(v => headerNames.includes(v) || labelNames.includes(v));
    if (looksLikeHeader) grid = grid.slice(1);
    if (grid.length === 0) return;

    const { r: startR, c: startC } = focus.current;
    const next = cells.map(row => [...row]);
    grid.forEach((line, ri) => {
      const r = startR + ri;
      while (next.length <= r) next.push(emptyRow(columns.length));
      line.forEach((val, ci) => {
        const c = startC + ci;
        if (c < columns.length) next[r][c] = val.trim();
      });
    });
    publish(withTrailingBlank(next));
  };

  const removeRow = (r: number) => {
    const next = cells.filter((_, i) => i !== r);
    publish(withTrailingBlank(next.length ? next : [emptyRow(columns.length)]));
  };

  const clearAll = () => {
    publish(Array.from({ length: START_ROWS }, () => emptyRow(columns.length)));
  };

  const filled = cells.filter(row => row.some(v => v.trim() !== '')).length;

  return (
    <div className="space-y-2" onPaste={handlePaste}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[11px] font-bold text-slate-600">
          اكتب نزولاً — أو الصق قائمتك من Excel بـ<b>Ctrl+V</b> في أي خانة.
        </span>
        {filled > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] font-extrabold text-slate-600 hover:text-rose-700 inline-flex items-center gap-1 cursor-pointer"
          >
            <Eraser className="w-3.5 h-3.5" /> مسح الكل
          </button>
        )}
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden">
        {/* الترويسة */}
        <div className="flex items-stretch gap-1.5 px-2 py-2 bg-slate-50 border-b border-slate-200">
          <span className="w-7 flex-shrink-0" />
          {columns.map(col => (
            <span key={col.header} className={`${col.width} text-[11px] font-extrabold text-[#0B1F4D]`}>
              {col.label}
              {col.required && <span className="text-rose-700" title="مطلوب"> *</span>}
            </span>
          ))}
          <span className="w-7 flex-shrink-0" />
        </div>

        {/* الصفوف */}
        <div className="max-h-[46vh] overflow-y-auto divide-y divide-slate-50">
          {cells.map((row, r) => {
            const rowFilled = row.some(v => v.trim() !== '');
            return (
              <div key={r} className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-slate-50/60">
                <span className="w-7 flex-shrink-0 text-[10px] font-mono text-slate-500 text-center">
                  {toArabicDigits(r + 1)}
                </span>
                {columns.map((col, c) => {
                  const shared = `${col.width} px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold outline-none focus:border-[#0B1F4D] focus:ring-1 focus:ring-[#0B1F4D]`;
                  const onFocus = () => { focus.current = { r, c }; };
                  return col.kind === 'number' ? (
                    <NumberInput
                      key={col.header}
                      inputMode="decimal"
                      value={row[c]}
                      onValueChange={(v) => setCell(r, c, v)}
                      onFocus={onFocus}
                      placeholder={col.hint}
                      className={`${shared} text-center font-mono`}
                    />
                  ) : (
                    <input
                      key={col.header}
                      type="text"
                      value={row[c]}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      onFocus={onFocus}
                      placeholder={col.hint}
                      className={shared}
                    />
                  );
                })}
                <button
                  type="button"
                  onClick={() => removeRow(r)}
                  disabled={!rowFilled}
                  title="حذف هذا الصف"
                  className="w-7 h-7 flex-shrink-0 rounded-lg flex items-center justify-center text-slate-500 hover:text-rose-700 hover:bg-rose-50 disabled:opacity-0 disabled:cursor-default cursor-pointer transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => publish([...cells, emptyRow(columns.length)])}
          className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-[11px] font-extrabold text-[#0B1F4D] inline-flex items-center gap-1 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> صف جديد
        </button>
        <span className="text-[11px] font-extrabold text-slate-600">
          {filled > 0 ? `${toArabicDigits(filled)} صفاً مكتوباً` : 'لم تكتب شيئاً بعد'}
        </span>
      </div>
    </div>
  );
}

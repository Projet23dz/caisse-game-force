import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { type Db, many, one } from '../db';
import { forbidden } from '../errors';
import { resolveKey } from '../files';
import { ctx, type Deps } from '../http';
import { ledgerFilter, ledgerWhere } from './transactions';

export const TYPE_LABELS: Record<string, Record<string, string>> = {
  ar: { income: 'إيراد', expense: 'مصروف', purchase: 'شراء', deposit: 'إيداع', withdrawal: 'سحب', transfer_out: 'تحويل صادر',
    transfer_in: 'تحويل وارد', adjustment_in: 'تسوية فائض', adjustment_out: 'تسوية عجز', salary_advance: 'تسبيق أجر', salary_payment: 'دفع أجر' },
  fr: { income: 'Recette', expense: 'Dépense', purchase: 'Achat', deposit: 'Apport', withdrawal: 'Retrait', transfer_out: 'Transfert (sortie)',
    transfer_in: 'Transfert (entrée)', adjustment_in: 'Ajustement +', adjustment_out: 'Ajustement −', salary_advance: 'Avance salaire', salary_payment: 'Paiement salaire' },
  en: { income: 'Income', expense: 'Expense', purchase: 'Purchase', deposit: 'Deposit', withdrawal: 'Withdrawal', transfer_out: 'Transfer out',
    transfer_in: 'Transfer in', adjustment_in: 'Adjustment +', adjustment_out: 'Adjustment −', salary_advance: 'Salary advance', salary_payment: 'Salary payment' },
};
const HEAD: Record<string, string[]> = {
  ar: ['رقم', 'التاريخ', 'النشاط', 'الحساب', 'النوع', 'الفئة', 'المورّد / العامل', 'الوصف', 'المرجع', 'المبلغ', 'الحالة', 'المستخدم'],
  fr: ['N°', 'Date', 'Activité', 'Compte', 'Type', 'Catégorie', 'Fournisseur / employé', 'Description', 'Référence', 'Montant', 'Statut', 'Utilisateur'],
  en: ['No.', 'Date', 'Business', 'Account', 'Type', 'Category', 'Supplier / employee', 'Description', 'Reference', 'Amount', 'Status', 'User'],
};
const STATUS: Record<string, Record<string, string>> = {
  ar: { validated: 'مُصادَق', cancelled: 'ملغاة' }, fr: { validated: 'Validée', cancelled: 'Annulée' }, en: { validated: 'Validated', cancelled: 'Cancelled' },
};
const TITLE: Record<string, string> = { ar: 'كشف العمليات', fr: 'Relevé des opérations', en: 'Transactions statement' };

interface Row {
  ref_no: string; transaction_date: Date; business_name: string; account_name: string; transaction_type: string;
  category_name: string | null; supplier_name: string | null; employee_name: string | null; description: string | null;
  reference: string | null; signed_amount: string; status: string; created_by_name: string; business_id: string;
}

const fmtDate = (d: Date) => new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const fmtMoney = (n: number) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n).replace(/\u202f|\u00a0/g, ' ');

function pdfFont(): string | null {
  const candidates = [process.env.PDF_FONT, 'C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\tahoma.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].filter(Boolean) as string[];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

async function loadRows(db: Db, q: z.infer<typeof ledgerFilter>): Promise<{ rows: Row[]; bizIds: string[] }> {
  // seules les activités où l'utilisateur a la permission « export »
  const mine = await many<{ id: string; permissions: Record<string, boolean> }>(db, 'SELECT id, permissions FROM my_businesses()');
  const allowed = mine.filter((b) => b.permissions?.export).map((b) => b.id);
  if (q.businessId && !allowed.includes(q.businessId)) throw forbidden('Permission refusée (export)');
  const ids = q.businessId ? [q.businessId] : allowed;
  if (!ids.length) throw forbidden('Permission refusée (export)');
  const w = ledgerWhere(q);
  w.add('business_id = ANY(?::uuid[])', ids);
  const rows = await many<Row>(db, `SELECT * FROM v_ledger ${w} ORDER BY transaction_date, ref_no LIMIT 50000`, w.params);
  await db.query("SELECT log_event('export', $1, $2::jsonb)", [q.businessId ?? null, JSON.stringify({ rows: rows.length, filters: q })]);
  return { rows, bizIds: ids };
}

async function logoFor(db: Db, dataDir: string, bizIds: string[]): Promise<{ file: string; ext: 'png' | 'jpeg' } | null> {
  const r = bizIds.length === 1
    ? await one<{ k: string | null }>(db, 'SELECT logo_path AS k FROM businesses WHERE id = $1', [bizIds[0]])
    : await one<{ k: string | null }>(db, "SELECT value #>> '{}' AS k FROM app_settings WHERE key = 'app_logo'");
  if (!r?.k || !/\.(png|jpg)$/.test(r.k)) return null;            // PDF/Excel : PNG ou JPG uniquement
  const file = resolveKey(dataDir, r.k);
  return fs.existsSync(file) ? { file, ext: r.k.endsWith('.png') ? 'png' : 'jpeg' } : null;
}

function cells(r: Row, lang: string) {
  return [r.ref_no, fmtDate(r.transaction_date), r.business_name, r.account_name, TYPE_LABELS[lang][r.transaction_type] ?? r.transaction_type,
    r.category_name ?? '', r.supplier_name ?? r.employee_name ?? '', r.description ?? '', r.reference ?? '',
    Number(r.signed_amount), STATUS[lang][r.status] ?? r.status, r.created_by_name];
}

function sendCsv(res: Response, rows: Row[], lang: string, name: string) {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [HEAD[lang].map(esc).join(';'), ...rows.map((r) => cells(r, lang).map((v, i) => esc(i === 9 ? Number(v).toFixed(2) : v)).join(';'))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.end('\ufeff' + lines.join('\r\n'));
}

async function sendXlsx(res: Response, rows: Row[], lang: string, name: string, logo: { file: string; ext: 'png' | 'jpeg' } | null, period: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CashPro';
  const ws = wb.addWorksheet(TITLE[lang], { views: [{ rightToLeft: lang === 'ar', state: 'frozen', ySplit: 4 }] });
  ws.columns = [8, 17, 16, 18, 16, 22, 22, 34, 14, 16, 12, 18].map((width) => ({ width }));
  if (logo) {
    const id = wb.addImage({ filename: logo.file, extension: logo.ext });
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 48, height: 48 } });
  }
  ws.mergeCells('B1:H1');
  ws.getCell('B1').value = `CashPro — ${TITLE[lang]}`;
  ws.getCell('B1').font = { bold: true, size: 16, color: { argb: 'FF1F2A7A' } };
  ws.mergeCells('B2:H2');
  ws.getCell('B2').value = period;
  ws.getCell('B2').font = { size: 11, color: { argb: 'FF50567A' } };
  const header = ws.getRow(4);
  header.values = HEAD[lang];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A7A' } }; c.alignment = { vertical: 'middle' }; });
  header.height = 22;
  let tin = 0; let tout = 0;
  for (const r of rows) {
    const row = ws.addRow(cells(r, lang));
    const amt = Number(r.signed_amount);
    row.getCell(10).numFmt = '#,##0.00;[Red]-#,##0.00';
    if (r.status === 'cancelled') row.font = { strike: true, color: { argb: 'FF9CA3AF' } };
    else if (amt >= 0) tin += amt; else tout += -amt;
  }
  ws.addRow([]);
  const labels = lang === 'ar' ? ['مجموع الداخل', 'مجموع الخارج', 'الصافي'] : lang === 'fr' ? ['Total entrées', 'Total sorties', 'Net'] : ['Total in', 'Total out', 'Net'];
  [[labels[0], tin], [labels[1], -tout], [labels[2], tin - tout]].forEach(([l, v]) => {
    const row = ws.addRow(['', '', '', '', '', '', '', '', l, v]);
    row.font = { bold: true };
    row.getCell(10).numFmt = '#,##0.00;[Red]-#,##0.00';
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 12 } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// pdfkit chargé en module ES à la demande : fonctionne aussi sous Node.js 18 (version d'essai Windows 7),
// où require() d'un module ES (fontkit) est impossible.
type PdfCtor = typeof import('pdfkit');
let pdfkitMod: Promise<PdfCtor> | null = null;
const loadPdfkit = (): Promise<PdfCtor> =>
  (pdfkitMod ??= import('pdfkit').then((m) => ((m as unknown as { default?: PdfCtor }).default ?? m) as PdfCtor));

async function sendPdf(res: Response, rows: Row[], lang: string, name: string, logo: { file: string } | null, period: string) {
  const PDFDocument = await loadPdfkit();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: `CashPro — ${TITLE[lang]}`, Creator: 'CashPro' } });
  const font = pdfFont();
  if (font) doc.registerFont('body', font).font('body'); else doc.font('Helvetica');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  doc.pipe(res);
  const rtl = lang === 'ar';
  // Mise en forme arabe (fontkit) seulement pour un texte arabe sans chiffres ni lettres latines :
  // un texte mixte garderait sinon ses nombres à l'envers.
  const arabicOnly = (s: string) => /[\u0600-\u06FF]/.test(s) && !/[A-Za-z0-9]/.test(s);
  const opt = (o: PDFKit.Mixins.TextOptions = {}, s = ''): PDFKit.Mixins.TextOptions => (arabicOnly(s) ? { ...o, features: ['rtla'] } : o);
  if (logo) doc.image(logo.file, 32, 28, { fit: [44, 44] });
  doc.fillColor('#1F2A7A').fontSize(18).text('CashPro', logo ? 86 : 32, 32);
  doc.text(TITLE[lang], (logo ? 86 : 32) + doc.widthOfString('CashPro  '), 32, opt({}, TITLE[lang]));
  doc.fillColor('#50567A').fontSize(10).text(period, logo ? 86 : 32, 56, opt({}, period));
  // colonnes : N°, date, activité, compte, type, catégorie, description, montant
  const widths = [40, 100, 80, 90, 80, 105, 183, 100];
  const idx = [0, 1, 2, 3, 4, 5, 7, 9];
  const order = rtl ? [...idx.keys()].reverse() : [...idx.keys()];
  const x0 = 32;
  let y = 90;
  const drawRow = (vals: string[], head: boolean, strike = false) => {
    if (y > doc.page.height - 50) { doc.addPage(); y = 40; }
    if (head) doc.rect(x0, y - 3, widths.reduce((a, b) => a + b, 0), 18).fill('#1F2A7A');
    let x = x0;
    for (const i of order) {
      const w = widths[i];
      doc.fillColor(head ? '#FFFFFF' : strike ? '#9CA3AF' : '#121633').fontSize(head ? 8.5 : 8)
        .text(vals[i], x + 3, y, opt({ width: w - 6, height: 12, ellipsis: true, lineBreak: false, align: i === 7 ? 'right' : rtl ? 'right' : 'left' }, vals[i]));
      x += w;
    }
    if (strike) doc.moveTo(x0, y + 4).lineTo(x, y + 4).strokeColor('#9CA3AF').lineWidth(0.5).stroke();
    y += 16;
  };
  drawRow(idx.map((i) => HEAD[lang][i]), true);
  let tin = 0; let tout = 0;
  for (const r of rows) {
    const c = cells(r, lang);
    const amt = Number(r.signed_amount);
    if (r.status !== 'cancelled') { if (amt >= 0) tin += amt; else tout += -amt; }
    drawRow(idx.map((i) => (i === 9 ? fmtMoney(amt) : String(c[i]))), false, r.status === 'cancelled');
  }
  y += 8;
  const t = lang === 'ar' ? ['الداخل', 'الخارج', 'الصافي'] : lang === 'fr' ? ['Entrées', 'Sorties', 'Net'] : ['In', 'Out', 'Net'];
  doc.fillColor('#121633').fontSize(10);
  // totaux : chaque morceau dessiné séparément (libellé arabe mis en forme, montant en chiffres)
  const parts: string[] = [];
  [[t[0], tin], [t[1], tout], [t[2], tin - tout]].forEach(([l, v], k) => {
    if (k) parts.push('   ·   ');
    parts.push(`${l} :`, ` ${fmtMoney(Number(v))} DA`);
  });
  let tx = rtl ? doc.page.width - 32 : x0;
  for (const piece of parts) {
    const w = doc.widthOfString(piece, opt({}, piece));
    if (rtl) tx -= w;
    doc.text(piece, tx, y, opt({ lineBreak: false }, piece));
    if (!rtl) tx += w;
  }
  doc.end();
}

export function exportRoutes(deps: Deps): Router {
  const r = Router();
  r.get('/export/transactions', async (req, res) => {
    const q = ledgerFilter.parse(req.query);
    const { format, lang } = z.object({ format: z.enum(['xlsx', 'csv', 'pdf']), lang: z.enum(['ar', 'fr', 'en']).default('fr') }).parse(req.query);
    const { rows, logo } = await deps.db.tx(ctx(req), async (db) => {
      const out = await loadRows(db, q);
      return { rows: out.rows, logo: await logoFor(db, deps.dataDir, out.bizIds) };
    });
    const name = `cashpro-operations-${new Date().toISOString().slice(0, 10)}`;
    const period = [q.from, q.to].filter(Boolean).join(' → ') || (lang === 'ar' ? 'كل الفترات' : lang === 'fr' ? 'Toutes périodes' : 'All periods');
    if (format === 'csv') return sendCsv(res, rows, lang, name);
    if (format === 'xlsx') return sendXlsx(res, rows, lang, name, logo, period);
    return sendPdf(res, rows, lang, path.basename(name), logo, period);
  });
  return r;
}

// Script Google Apps Script collé par l'administrateur dans son classeur Google Sheets
// (Extensions → Apps Script), puis déployé en « Application Web ». Le serveur CashPro lui envoie
// un instantané complet (POST JSON) ; le script réécrit les feuilles avec un style « Black & Gold ».
// __CASHPRO_TOKEN__ est remplacé par le jeton secret au téléchargement (GET /api/admin/sheets/script).
// Attention : pas d'accent grave (backtick) ni de « ${ » dans ce texte.
export const APPS_SCRIPT = String.raw`/**
 * CashPro → Google Sheets (lecture seule)
 * Ce script reçoit les données du serveur CashPro et met à jour les feuilles.
 * Ne modifiez pas le jeton ci-dessous : il protège le classeur.
 * هذا السكريبت يستقبل بيانات CashPro ويحدّث الأوراق. لا تغيّر الرمز السري.
 */
var TOKEN = '__CASHPRO_TOKEN__';
var TZ = 'Africa/Algiers';
var FONT = 'Cairo';
var HEAD_ROW = 5;          // ligne des en-têtes de tableau
var C = {
  bg: '#0B0B10', panel: '#15151D', band: '#1C1C27', line: '#2B2B38',
  gold: '#D4A23A', goldHi: '#F3D98B', goldDk: '#7A5718', ink: '#1A1206',
  text: '#EFE8D8', muted: '#8F889C', good: '#3DDC97', bad: '#FF6B6B', warn: '#F5B041'
};
var SOLID = SpreadsheetApp.BorderStyle.SOLID;
var THICK = SpreadsheetApp.BorderStyle.SOLID_THICK;
var MEDIUM = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;

function doGet() { return out_({ ok: true, app: 'CashPro Sheets' }); }

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return out_({ ok: false, error: 'bad_json' }); }
  if (!body || body.token !== TOKEN) return out_({ ok: false, error: 'unauthorized' });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return out_({ ok: false, error: 'busy' });
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ);
    if (body.ping) { ping_(ss, body); return out_({ ok: true, ping: true }); }
    write_(ss, body);
    return out_({ ok: true, rows: (body.sheets || []).reduce(function (n, s) { return n + s.rows.length; }, 0) });
  } catch (x) {
    return out_({ ok: false, error: 'script', message: String(x && x.message || x) });
  } finally {
    lock.releaseLock();
  }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fmt_(iso) { return iso ? Utilities.formatDate(new Date(iso), TZ, 'dd/MM/yyyy HH:mm') : '—'; }

// ------------------------------------------------------------------ écriture complète
function write_(ss, body) {
  var rtl = body.rtl !== false;
  var specs = [{ key: 'summary', title: body.summary.title }].concat(body.sheets);
  // 1. créer les feuilles (il faut leurs identifiants pour les boutons de navigation)
  var sheets = specs.map(function (s, i) {
    var sh = ss.getSheetByName(s.title) || ss.insertSheet(s.title, i);
    return sh;
  });
  sheets.forEach(function (sh, i) { if (sh.getIndex() !== i + 1) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); } });
  // supprimer les feuilles vides par défaut (« Feuille 1 », « Sheet1 »…)
  var mine = specs.map(function (s) { return s.title; });
  ss.getSheets().forEach(function (sh) { if (mine.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh); });
  var nav = specs.map(function (s, i) { return { title: s.nav || s.title, gid: sheets[i].getSheetId() }; });

  PropertiesService.getScriptProperties().setProperty('summary', body.summary.title);
  summary_(sheets[0], body, nav, rtl);
  body.sheets.forEach(function (s, i) { table_(sheets[i + 1], s, body, nav, i + 1, rtl); });
  ss.setActiveSheet(sheets[0]);
}

// Prépare une feuille : taille exacte, fond sombre, aucune grille, protégée (avertissement à la modification)
function reset_(sh, rows, cols, rtl) {
  sh.setRightToLeft(rtl);
  sh.setHiddenGridlines(true);
  sh.setFrozenRows(0);
  var mr = sh.getMaxRows(), mc = sh.getMaxColumns();
  sh.getRange(1, 1, mr, mc).breakApart();
  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.clearConditionalFormatRules();
  sh.clear();
  if (mr < rows) sh.insertRowsAfter(mr, rows - mr); else if (mr > rows) sh.deleteRows(rows + 1, mr - rows);
  if (mc < cols) sh.insertColumnsAfter(mc, cols - mc); else if (mc > cols) sh.deleteColumns(cols + 1, mc - cols);
  sh.getRange(1, 1, rows, cols).setBackground(C.bg).setFontFamily(FONT).setFontColor(C.text).setFontSize(10)
    .setVerticalAlignment('middle');
  sh.setRowHeights(1, rows, 28);
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.protect().setDescription('CashPro — lecture seule / للقراءة فقط').setWarningOnly(true);
}

// Bouton « 3D » : fond or, reflet clair en haut, ombre foncée épaisse en bas, séparé par une marge sombre
function button_(rg, active) {
  rg.setBackground(active ? C.goldHi : C.gold).setFontColor(C.ink).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
  rg.setBorder(true, null, null, null, null, null, active ? '#FFF4CF' : C.goldHi, MEDIUM);
  rg.setBorder(null, null, true, null, null, null, C.goldDk, THICK);
  rg.setBorder(null, true, null, true, true, null, C.bg, THICK);   // marges entre boutons
}

function banner_(sh, cols, title, sub) {
  sh.getRange(1, 1, 1, cols).merge().setValue('◆  ' + title + '  ◆').setFontSize(20).setFontWeight('bold')
    .setFontColor(C.gold).setHorizontalAlignment('center').setBackground(C.bg);
  sh.setRowHeight(1, 58);
  sh.getRange(1, 1, 1, cols).setBorder(null, null, true, null, null, null, C.gold, SOLID);
  if (sub) sh.getRange(3, 1, 1, cols).merge().setValue(sub).setFontColor(C.muted).setHorizontalAlignment('center').setFontSize(9);
  sh.setRowHeight(4, 10);
}

function navRow_(sh, nav, current, firstCol, cols) {
  var n = Math.min(nav.length, cols - firstCol + 1);
  var f = [];
  for (var i = 0; i < n; i++) f.push('=HYPERLINK("#gid=' + nav[i].gid + '","' + nav[i].title.replace(/"/g, '') + '")');
  var rg = sh.getRange(2, firstCol, 1, n);
  rg.setFormulas([f]);
  for (var j = 0; j < n; j++) button_(sh.getRange(2, firstCol + j), j === current);
  sh.setRowHeight(2, 34);
}

// ------------------------------------------------------------------ feuille « tableau »
var FORMATS = { money: '#,##0.00', signed: '#,##0.00;-#,##0.00;0.00', int: '0', date: 'dd/mm/yyyy', datetime: 'dd/mm/yyyy hh:mm', month: 'mm/yyyy', text: '@' };

function table_(sh, s, body, nav, idx, rtl) {
  var cols = Math.max(s.headers.length, nav.length);
  var n = Math.max(s.rows.length, 1);
  var rows = HEAD_ROW + n + 1;
  reset_(sh, rows, cols, rtl);
  banner_(sh, cols, s.title, body.labels.updated + ' : ' + fmt_(body.at) + (s.note ? '   ·   ' + s.note : ''));
  navRow_(sh, nav, idx, 1, cols);

  var hc = s.headers.length;
  var head = sh.getRange(HEAD_ROW, 1, 1, hc);
  head.setValues([s.headers]).setWrap(true);
  button_(head, false);
  sh.setRowHeight(HEAD_ROW, 40);
  sh.setFrozenRows(HEAD_ROW);

  var data = sh.getRange(HEAD_ROW + 1, 1, n, hc);
  if (s.rows.length) {
    var values = s.rows.map(function (r) {
      return r.map(function (v, c) {
        var t = s.types[c];
        if (v === null || v === undefined) return '';
        if ((t === 'date' || t === 'datetime' || t === 'month') && v) return new Date(v);
        return v;
      });
    });
    s.types.forEach(function (t, c) { if (FORMATS[t]) sh.getRange(HEAD_ROW + 1, c + 1, n, 1).setNumberFormat(FORMATS[t]); });
    data.setValues(values);
  } else {
    sh.getRange(HEAD_ROW + 1, 1, 1, hc).merge().setValue(body.labels.empty).setHorizontalAlignment('center').setFontColor(C.muted);
  }
  var band = data.applyRowBanding(SpreadsheetApp.BandingTheme.GREY, false, false);
  band.setFirstRowColor(C.panel).setSecondRowColor(C.band);
  data.setBorder(null, null, true, null, null, true, C.line, SOLID);
  sh.setRowHeights(HEAD_ROW + 1, n, 30);
  s.types.forEach(function (t, c) {
    var col = sh.getRange(HEAD_ROW + 1, c + 1, n, 1);
    if (t === 'money' || t === 'signed' || t === 'int') col.setHorizontalAlignment('center').setFontWeight('bold');
    else if (t === 'date' || t === 'datetime' || t === 'month' || t === 'badge') col.setHorizontalAlignment('center');
    if (t === 'money') col.setFontColor(C.goldHi);
    if (t === 'badge') col.setFontWeight('bold');
  });
  // pied de tableau : fine ligne or
  sh.getRange(rows, 1, 1, cols).setBorder(true, null, null, null, null, null, C.gold, SOLID);

  // couleurs conditionnelles : + vert, − rouge, lignes annulées barrées, badges
  var rules = [];
  s.types.forEach(function (t, c) {
    if (t !== 'signed') return;
    var col = sh.getRange(HEAD_ROW + 1, c + 1, n, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor(C.good).setRanges([col]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(C.bad).setRanges([col]).build());
  });
  (s.marks || []).forEach(function (m) {
    var letter = colLetter_(m.col + 1);
    var target = m.row ? data : sh.getRange(HEAD_ROW + 1, m.col + 1, n, 1);
    var rule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + letter + (HEAD_ROW + 1) + '="' + String(m.value).replace(/"/g, '') + '"').setRanges([target]);
    if (m.tone === 'muted') rule.setFontColor(C.muted).setStrikethrough(true);
    else if (m.tone === 'bad') rule.setFontColor(C.bad).setBold(true);
    else if (m.tone === 'good') rule.setFontColor(C.good).setBold(true);
    else if (m.tone === 'warn') rule.setFontColor(C.warn).setBold(true);
    rules.push(rule.build());
  });
  sh.setConditionalFormatRules(rules);
  (s.widths || []).forEach(function (w, c) { sh.setColumnWidth(c + 1, w); });
  for (var c = hc; c < cols; c++) sh.setColumnWidth(c + 1, 120);
}

function colLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// ------------------------------------------------------------------ feuille « الملخص » : cartes
function summary_(sh, body, nav, rtl) {
  var S = body.summary;
  var cards = S.cards || [];
  var COLS = 8;                      // A : marge, B–G : 2 cartes × 3 colonnes, H : marge
  var cardRows = cards.map(function (c) { return 3 + c.rows.length; });
  var rows = 9;
  for (var i = 0; i < cards.length; i += 2) rows += Math.max(cardRows[i], cardRows[i + 1] || 0) + 1;
  reset_(sh, rows + 1, COLS, rtl);
  banner_(sh, COLS, S.title, null);
  navRow_(sh, nav, 0, 2, COLS - 1);
  sh.setColumnWidth(1, 18); sh.setColumnWidth(COLS, 18);
  for (var c = 2; c < COLS; c++) sh.setColumnWidth(c, 150);
  sh.getRange(3, 2, 1, 3).merge().setValue(body.labels.updated + ' : ' + fmt_(body.at)).setFontColor(C.muted).setFontSize(9).setHorizontalAlignment('center');
  sh.getRange(3, 5, 1, 3).merge().setValue(body.labels.contact + ' : ' + fmt_(body.at)).setFontColor(C.muted).setFontSize(9).setHorizontalAlignment('center');

  // grande carte : trésorerie totale
  var t = sh.getRange(5, 2, 1, 6).merge().setValue(S.total.label);
  button_(t, false); t.setFontSize(12);
  sh.setRowHeight(5, 36);
  var v = sh.getRange(6, 2, 1, 6).merge().setValue(S.total.value).setNumberFormat(FORMATS.money + ' "' + S.currency + '"')
    .setFontSize(30).setFontWeight('bold').setFontColor(C.goldHi).setHorizontalAlignment('center').setBackground(C.panel);
  sh.setRowHeight(6, 70);
  sh.getRange(7, 2, 1, 6).merge().setValue(S.total.note || '').setFontColor(C.muted).setFontSize(9)
    .setHorizontalAlignment('center').setBackground(C.panel);
  card_(sh.getRange(5, 2, 3, 6));
  sh.setRowHeight(8, 14);

  // cartes des activités, deux par ligne
  var r = 9;
  for (var k = 0; k < cards.length; k += 2) {
    [cards[k], cards[k + 1]].forEach(function (cd, j) {
      if (!cd) return;
      var c0 = 2 + j * 3;
      var hd = sh.getRange(r, c0, 1, 3).merge().setValue(cd.name);
      button_(hd, false); hd.setFontSize(12);
      sh.setRowHeight(r, 36);
      sh.getRange(r + 1, c0, 1, 3).merge().setValue(cd.value).setNumberFormat(FORMATS.money + ' "' + S.currency + '"')
        .setFontSize(20).setFontWeight('bold').setHorizontalAlignment('center').setBackground(C.panel)
        .setFontColor(cd.value < 0 ? C.bad : C.goldHi);
      sh.setRowHeight(r + 1, 54);
      cd.rows.forEach(function (row, q) {
        var rr = r + 2 + q;
        sh.getRange(rr, c0, 1, 2).merge().setValue(row[0]).setFontColor(C.muted).setBackground(C.panel).setHorizontalAlignment(rtl ? 'right' : 'left');
        sh.getRange(rr, c0 + 2).setValue(row[1]).setNumberFormat(row[2] === 'int' ? '0' : FORMATS.money).setFontWeight('bold')
          .setBackground(C.panel).setHorizontalAlignment('center')
          .setFontColor(row[2] === 'good' ? C.good : row[2] === 'bad' ? C.bad : C.text);
      });
      var last = r + 2 + cd.rows.length;
      sh.getRange(last, c0, 1, 3).merge().setBackground(C.panel);
      sh.setRowHeight(last, 10);
      card_(sh.getRange(r, c0, 3 + cd.rows.length, 3));
    });
    r += Math.max(cardRows[k], cardRows[k + 1] || 0) + 1;
    sh.setRowHeight(r - 1, 14);
  }
}

// Carte : cadre or fin + ombre portée (bordure épaisse foncée en bas)
function card_(rg) {
  rg.setBorder(true, true, null, true, null, null, C.goldDk, SOLID);
  rg.setBorder(null, null, true, null, null, null, '#000000', THICK);
}

// Pas de changement côté serveur : on met seulement à jour « آخر اتصال »
function ping_(ss, body) {
  var name = PropertiesService.getScriptProperties().getProperty('summary');
  var sh = name && ss.getSheetByName(name);
  if (sh) sh.getRange(3, 5).setValue(body.labels.contact + ' : ' + fmt_(body.at));
}
`;

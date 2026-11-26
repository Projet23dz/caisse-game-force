// 1.2.0 — Types d'opération personnalisés (أنواع العمليات) : créés et gérés par l'administrateur.
// Un type = un nom + un sens (entrée ⬆ comme un revenu, sortie ⬇ comme une dépense) + une couleur ; ses catégories
// se créent ensuite dans chaque activité (Paramètres de l'activité → Catégories), comme pour les autres types.
import { api, errMsg, field, formData, h, icon, input, isAdmin, loadOpTypes, modal, opTypes, post, toast, type OpType } from '../core.js';
import { t } from '../i18n.js';

export function openOpTypeForm(o: OpType | null, done: () => void) {
  if (!isAdmin()) return;
  const dirIn = h('input', { type: 'radio', name: 'direction', value: 'in', checked: o?.dir === 'in', disabled: !!o }) as HTMLInputElement;
  const dirOut = h('input', { type: 'radio', name: 'direction', value: 'out', checked: !o || o.dir === 'out', disabled: !!o }) as HTMLInputElement;
  const f = h('div', { class: 'form' },
    field(t('name'), input('name', { required: true, maxlength: '60', value: o?.name ?? '', placeholder: t('op_type_example') }), 'full'),
    h('div', { class: 'col full', style: 'gap:6px' }, h('b', null, t('op_type_direction')),
      h('label', { class: 'check' }, dirIn, h('span', { class: 'c-income' }, '⬆ ', t('dir_in')), h('span', { class: 'muted small' }, ` — ${t('dir_in_hint')}`)),
      h('label', { class: 'check' }, dirOut, h('span', { class: 'c-expense' }, '⬇ ', t('dir_out')), h('span', { class: 'muted small' }, ` — ${t('dir_out_hint')}`)),
      o ? h('span', { class: 'muted small' }, t('op_type_dir_fixed')) : null),
    field(t('color'), input('color', { type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(o?.color ?? '') ? o!.color! : '#f59e0b', style: 'min-height:44px;padding:4px' })),
    o ? h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'isActive', checked: o.is_active }), t('active')) : null,
    h('div', { class: 'info-box full small' }, t('op_type_hint')));
  modal({ title: o ? `${t('edit')} — ${o.name}` : t('new_op_type'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    if (o) await api('PATCH', `/op-types/${o.id}`, { name: d.name, color: d.color, isActive: d.isActive === '1' });
    else await post('/op-types', { name: d.name, direction: dirIn.checked ? 'in' : 'out', color: d.color });
    await loadOpTypes();
    close(); done();
  } });
}

/** Carte des paramètres : liste des types personnalisés. */
export function opTypesCard(rerun: () => void): HTMLElement {
  const list = opTypes(false);
  return h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, icon('tag'), ' ', t('op_types_title')), h('span', { class: 'spacer' }),
      h('button', { class: 'btn pri sm', onclick: () => openOpTypeForm(null, rerun) }, icon('plus', 15), t('new_op_type'))),
    h('p', { class: 'muted small', style: 'margin:0' }, t('op_types_hint')),
    list.length
      ? h('div', { class: 'col', style: 'gap:6px' }, list.map((o) => h('div', { class: 'row', style: `gap:8px;${o.is_active ? '' : 'opacity:.55'}` },
        h('span', { style: `width:12px;height:12px;border-radius:4px;flex:none;background:${o.color ?? 'var(--mu)'}` }),
        h('b', { style: `flex:1;${o.is_active ? '' : 'text-decoration:line-through'}` }, o.name),
        h('span', { class: o.dir === 'in' ? 'c-income small' : 'c-expense small' }, o.dir === 'in' ? `⬆ ${t('dir_in')}` : `⬇ ${t('dir_out')}`),
        h('span', { class: 'muted small num' }, `${o.used} ${t('ops_count')}`),
        h('button', { class: 'btn ghost sm', title: t('edit'), 'aria-label': `${t('edit')} ${o.name}`, onclick: () => openOpTypeForm(o, rerun) }, icon('pen', 14)),
        h('button', { class: 'btn ghost sm', title: o.is_active ? t('deactivate') : t('activate'), onclick: async () => {
          try { await api('PATCH', `/op-types/${o.id}`, { isActive: !o.is_active }); await loadOpTypes(); toast(t('saved'), 'ok'); rerun(); }
          catch (e) { toast(errMsg(e), 'err'); }
        } }, o.is_active ? icon('x', 14) : icon('check', 14)))))
      : h('span', { class: 'muted small' }, t('op_types_none')));
}

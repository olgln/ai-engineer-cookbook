import * as P from '../progress/store';
import strings from '../../locales/ru.json';
import { format } from '../../locales/format.mjs';
import { $$, el } from '../dom';
import { checkboxLabel, clickTogglesItem } from './checklist.mjs';

const ui = strings.ui;

export function initChecklist(box: HTMLElement) {
  const id = box.dataset.chapter!;
  const inputs = $$<HTMLInputElement>('input[type="checkbox"]', box);
  const counter = el('div', { class: 'done-counter' });
  box.prepend(counter);
  const render = () => {
    const checks = P.chapter(id).checks ?? {};
    let done = 0;
    inputs.forEach((inp, i) => {
      inp.checked = !!checks[i];
      inp.closest('li')?.classList.toggle('checked', inp.checked);
      if (inp.checked) done++;
    });
    counter.textContent = format(ui.checklistCount, { done, total: inputs.length });
    counter.classList.toggle('complete', done === inputs.length);
  };
  inputs.forEach((inp, i) => {
    inp.disabled = false;
    inp.removeAttribute('disabled');
    inp.addEventListener('change', () => {
      (P.chapter(id).checks ??= {})[i] = inp.checked;
      P.save();
    });
    // whole line toggles the box
    inp.closest('li')?.addEventListener('click', (e) => {
      if (clickTogglesItem(e.target as HTMLElement, window.getSelection()?.toString() ?? '')) inp.click();
    });
  });
  render();
  P.onChange(render);
}

/** Name every task-list checkbox (the "done when" checklists, the tracker on the plan page) by its item text. */
export function labelCheckboxes() {
  for (const inp of $$<HTMLInputElement>('.sl-markdown-content li input[type="checkbox"]')) {
    const li = inp.closest('li');
    if (li && !inp.hasAttribute('aria-label')) inp.setAttribute('aria-label', checkboxLabel(li.textContent ?? ''));
  }
}

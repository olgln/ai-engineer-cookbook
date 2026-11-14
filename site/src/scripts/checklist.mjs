// Pure click logic for the "done when" checklist, kept apart from the DOM wiring in main.ts.

/** Elements inside a checklist item that keep their own click behaviour. */
export const OWN_CLICK_SELECTOR = 'a, button, input, label';

/**
 * Whether a click inside a checklist item should toggle its checkbox.
 * Clicks on code and plain text toggle; clicks on links and controls do not, and neither does
 * finishing a text selection (so code can still be selected and copied).
 * @param {{ closest(selector: string): unknown }} target the clicked element
 * @param {string} selectedText the current text selection
 */
export function clickTogglesItem(target, selectedText) {
  if (selectedText.trim() !== '') return false;
  return !target.closest(OWN_CLICK_SELECTOR);
}

/**
 * Accessible name of a task-list checkbox: the text of its item. Markdown task lists render a bare
 * <input type="checkbox"> next to the text, not inside a <label>, so a screen reader would say only "checkbox".
 * @param {string} itemText text content of the list item
 */
export const checkboxLabel = (itemText) => itemText.replace(/\s+/g, ' ').trim();

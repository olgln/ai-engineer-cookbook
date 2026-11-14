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

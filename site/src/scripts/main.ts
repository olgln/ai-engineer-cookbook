import * as P from './progress/store';
import { initAccountMenus } from './account/account-ui';
import { hasProgress } from './account/save-hint.mjs';
import { initSaveHint } from './account/save-hint-ui';
import { initChapterDone } from './chapter/chapter-done-ui';
import { initChecklist, labelCheckboxes } from './chapter/checklist-ui';
import { markLinks } from './course/chapter-marks-ui';
import { initIndex } from './course/index-page-ui';
import { $$ } from './dom';
import { openExternalLinksInNewTab } from './external-links';
import { initLanguageChoice } from './language/language-ui';
import { initMermaid } from './mermaid';
import { initQuiz, scrollToLinkedQuestion } from './quiz/quiz-ui';
import { initReview } from './quiz/review-ui';

async function boot() {
  void initAccountMenus();
  initLanguageChoice();
  openExternalLinksInNewTab();
  labelCheckboxes();
  void initMermaid();
  await P.load();
  initSaveHint(hasProgress(P.get()));
  $$<HTMLElement>('.quiz').forEach(initQuiz);
  $$<HTMLElement>('.done-list').forEach(initChecklist);
  $$<HTMLElement>('.chapter-done').forEach(initChapterDone);
  initIndex();
  void initReview();
  markLinks();
  P.onChange(markLinks);
  document.documentElement.classList.add('progress-ready');
  scrollToLinkedQuestion();
}

void boot();

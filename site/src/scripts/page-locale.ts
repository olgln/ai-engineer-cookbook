// The language of the current page (the <html lang> Starlight sets) and what the browser code needs in it:
// the UI strings and the chapter list with the page links of that language.
import chaptersByLang from '../generated/chapters.json';
import { DEFAULT_LOCALE } from '../config/app.mjs';
import { localeOf } from '../locales/locales.mjs';
import { stringsFor } from '../locales/strings.mjs';

export type Chapter = { id: string; week: number; num: string; title: string; href: string; readHref: string };

export const lang = localeOf(document.documentElement.lang).lang;
export const strings = stringsFor(lang);
export const chapters: Chapter[] = (chaptersByLang as Record<string, Chapter[]>)[lang] ?? chaptersByLang[DEFAULT_LOCALE.lang as keyof typeof chaptersByLang];

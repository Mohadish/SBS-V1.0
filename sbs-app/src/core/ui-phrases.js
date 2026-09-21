/**
 * SBS — the few words the APP writes into the PICTURE (V0.3.4.67).
 *
 * The app's own interface is English, and stays English. But a handful of
 * strings are not interface at all — the app draws them INTO the video: the
 * heading of a generated table of contents, the line it shows when there are
 * no chapters yet, the stand-in text of an empty note. Those belong to the
 * project's language, not the app's. A Hebrew film that opens on the English
 * words "Table of Contents" is simply wrong, and no amount of translating the
 * project could fix it, because the project never contained those words.
 *
 * This is deliberately NOT an i18n framework: it is a table of the strings
 * that reach a render, keyed by the project's active language, English when
 * the language is not listed. The PDF document has had the same idea for its
 * own page furniture since V0.3.4 (document-core.js TOC_TITLE / _PHRASES).
 *
 * Pure: no state, no DOM. Callers pass the language in.
 */

const PHRASES = {
  tocTitle: {
    en: 'Table of Contents', he: 'תוכן עניינים', ar: 'المحتويات',
    es: 'Índice', fr: 'Table des matières', de: 'Inhaltsverzeichnis',
    it: 'Indice', pt: 'Índice', ru: 'Содержание', nl: 'Inhoudsopgave',
    pl: 'Spis treści', tr: 'İçindekiler',
  },
  noChapters: {
    en: '(no chapters yet)', he: '(אין עדיין פרקים)', ar: '(لا توجد فصول بعد)',
    es: '(aún no hay capítulos)', fr: '(pas encore de chapitres)', de: '(noch keine Kapitel)',
    it: '(ancora nessun capitolo)', pt: '(ainda sem capítulos)', ru: '(пока нет глав)',
    nl: '(nog geen hoofdstukken)', pl: '(brak rozdziałów)', tr: '(henüz bölüm yok)',
  },
  emptyNote: {
    en: '(empty note)', he: '(הערה ריקה)', ar: '(ملاحظة فارغة)',
    es: '(nota vacía)', fr: '(note vide)', de: '(leere Notiz)',
    it: '(nota vuota)', pt: '(nota vazia)', ru: '(пустая заметка)',
    nl: '(lege notitie)', pl: '(pusta notatka)', tr: '(boş not)',
  },
};

const RTL = new Set(['he', 'ar', 'fa', 'ur', 'yi']);

/** 'he-IL' → 'he'; the legacy Hebrew code 'iw' → 'he'; junk → 'en'. */
export function baseLang(lang) {
  const b = String(lang || 'en').trim().toLowerCase().split(/[-_]/)[0];
  if (b === 'iw') return 'he';
  if (b === 'ji') return 'yi';
  return b || 'en';
}

/** Does this language read right to left? */
export function isRtlLang(lang) { return RTL.has(baseLang(lang)); }

/** The phrase in the project's language, English when that language is not listed. */
export function phrase(id, lang) {
  const row = PHRASES[id];
  if (!row) return '';
  return row[baseLang(lang)] || row.en;
}

// i18n.js — the words Autropy writes into the researcher's project.
//
// Scope is deliberately narrow: this translates only what Autropy WRITES — the
// provenance header on a note. The panel's own controls stay in English,
// because they are this tool's interface and not part of the record. What ends
// up in a project, beside the researcher's own prose, is a different matter: an
// English stamp on a Portuguese summary is a machine announcing that it was
// built somewhere else.
//
// The model is told the output language separately (see prompt.js). This is for
// the text Autropy composes itself, which must never be model-generated — a
// provenance claim written by the thing whose provenance it records is not a
// claim, it is a suggestion.
//
// The set is closed and small on purpose. Machine-translating these would make
// the one part of the note that must be exact the one part nobody checked, so
// an unlisted language falls back to English rather than to a guess.

const LANGUAGES = {
  pt: {
    itemMulti: 'Resumo do item gerado por máquina — descreve todas as páginas deste item',
    itemSingle: 'Resumo do item gerado por máquina — este item tem uma página',
    page: 'Resumo da página gerado por máquina',
    generated: (when, model) => `Gerado em ${when} por ${model}`,
    fromPages: n => `Com base em ${n} resumos de página.`,
    withTranscription: 'Com base na imagem e numa transcrição existente.',
    withoutTranscription: 'Com base na imagem; não havia transcrição disponível.',
    withContext: n =>
      `Escrito com ${n} página(s) anterior(es) à vista, portanto não é uma ` +
      'leitura independente apenas desta página.'
  },

  es: {
    itemMulti: 'Resumen del ítem generado por máquina — describe todas las páginas de este ítem',
    itemSingle: 'Resumen del ítem generado por máquina — este ítem tiene una página',
    page: 'Resumen de la página generado por máquina',
    generated: (when, model) => `Generado el ${when} por ${model}`,
    fromPages: n => `A partir de ${n} resúmenes de página.`,
    withTranscription: 'A partir de la imagen y de una transcripción existente.',
    withoutTranscription: 'A partir de la imagen; no había transcripción disponible.',
    withContext: n =>
      `Escrito con ${n} página(s) anterior(es) a la vista, por lo que no es una ` +
      'lectura independiente solo de esta página.'
  },

  fr: {
    itemMulti: 'Résumé de l\'objet généré par machine — décrit toutes les pages de cet objet',
    itemSingle: 'Résumé de l\'objet généré par machine — cet objet a une seule page',
    page: 'Résumé de la page généré par machine',
    generated: (when, model) => `Généré le ${when} par ${model}`,
    fromPages: n => `D'après ${n} résumés de page.`,
    withTranscription: 'D\'après l\'image et une transcription existante.',
    withoutTranscription: 'D\'après l\'image ; aucune transcription n\'était disponible.',
    withContext: n =>
      `Rédigé avec ${n} page(s) précédente(s) sous les yeux, ce n'est donc pas ` +
      'une lecture indépendante de cette seule page.'
  },

  it: {
    itemMulti: 'Riassunto dell\'item generato da una macchina — descrive tutte le pagine di questo item',
    itemSingle: 'Riassunto dell\'item generato da una macchina — questo item ha una pagina',
    page: 'Riassunto della pagina generato da una macchina',
    generated: (when, model) => `Generato il ${when} da ${model}`,
    fromPages: n => `Sulla base di ${n} riassunti di pagina.`,
    withTranscription: 'Sulla base dell\'immagine e di una trascrizione esistente.',
    withoutTranscription: 'Sulla base dell\'immagine; non era disponibile alcuna trascrizione.',
    withContext: n =>
      `Scritto con ${n} pagina/e precedente/i sotto gli occhi, quindi non è una ` +
      'lettura indipendente di questa sola pagina.'
  },

  de: {
    itemMulti: 'Maschinell erzeugte Objektzusammenfassung — beschreibt alle Seiten dieses Objekts',
    itemSingle: 'Maschinell erzeugte Objektzusammenfassung — dieses Objekt hat eine Seite',
    page: 'Maschinell erzeugte Seitenzusammenfassung',
    generated: (when, model) => `Erzeugt am ${when} von ${model}`,
    fromPages: n => `Auf Grundlage von ${n} Seitenzusammenfassungen.`,
    withTranscription: 'Auf Grundlage des Bildes und einer vorhandenen Transkription.',
    withoutTranscription: 'Auf Grundlage des Bildes; es lag keine Transkription vor.',
    withContext: n =>
      `Mit ${n} vorangehenden Seite(n) im Blick verfasst, also keine eigenständige ` +
      'Lesung allein dieser Seite.'
  },

  en: {
    itemMulti: 'Machine-generated item summary — describes all pages of this item',
    itemSingle: 'Machine-generated item summary — this item has one page',
    page: 'Machine-generated page summary',
    generated: (when, model) => `Generated ${when} by ${model}`,
    fromPages: n => `Based on ${n} page summaries.`,
    withTranscription: 'Based on the image and an existing transcription.',
    withoutTranscription: 'Based on the image; no transcription was available.',
    withContext: n =>
      `Written with the ${n} preceding page(s) in view, so it is not an ` +
      'independent reading of this page alone.'
  }
}

// The option is free text a researcher types — "Portuguese", "Português", "pt",
// "Brazilian Portuguese" are all the same request. Matched on a stripped,
// lowercased form so an accent or a region suffix does not silently fall back
// to English.
const ALIASES = [
  [/^(pt|por|portugues|portuguese|brazilian portuguese|portugues do brasil)/, 'pt'],
  [/^(es|spa|espanol|spanish|castellano)/, 'es'],
  [/^(fr|fra|francais|french)/, 'fr'],
  [/^(it|ita|italiano|italian)/, 'it'],
  [/^(de|deu|ger|deutsch|german)/, 'de'],
  [/^(en|eng|english|ingles)/, 'en']
]

export function languageCode (outputLanguage) {
  const raw = String(outputLanguage || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')

  if (!raw) return 'en'

  for (const [pattern, code] of ALIASES) {
    if (pattern.test(raw)) return code
  }

  return 'en'
}

// The strings for a language, or English. Never throws and never returns
// undefined: a missing translation must not be able to stop a note being
// written.
export function noteStrings (outputLanguage) {
  return LANGUAGES[languageCode(outputLanguage)] ?? LANGUAGES.en
}

export const TRANSLATED_LANGUAGES = Object.keys(LANGUAGES).filter(c => c !== 'en')

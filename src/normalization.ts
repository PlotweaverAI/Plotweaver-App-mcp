import type { StormLanguageCode } from './types.js';

/**
 * PlotWeaver Multilingual TTS Normalization Rules
 * Based on PlotWeaver Multilingual TTS Normalization Specification by Emmanuel Ariyo
 * 
 * Languages supported:
 * - 'yo': Yoruba
 * - 'ig': Igbo
 * - 'ha': Hausa
 * - 'pcm': Nigerian Pidgin
 * - 'en': Nigerian English
 */

/**
 * Normalize text according to language-specific phonetic and pronunciation rules.
 */
export function normalizeSpeechText(rawText: string, lang?: StormLanguageCode): string {
  if (!rawText || typeof rawText !== 'string') return '';

  let text = rawText
    // Strip markdown formatting (*, _, `, ~, #)
    .replace(/[*_`#~]/g, '')
    // Strip markdown link syntax: [Text](url) -> Text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip bullet points at start of lines (bullet must be followed by whitespace,
    // so negative numbers such as "-5 degrees" keep their sign)
    .replace(/^[ \t]*[•\-*][ \t]+/gm, '');

  switch (lang) {
    case 'yo':
      return normalizeYoruba(text);
    case 'ig':
      return normalizeIgbo(text);
    case 'ha':
      return normalizeHausa(text);
    case 'pcm':
      return normalizePidgin(text);
    case 'en':
    default:
      return normalizeNigerianEnglish(text);
  }
}

function normalizeYoruba(text: string): string {
  return text
    // Currencies
    .replace(/₦\s*([\d,.]+)\s*(?:million|mílíọ̀nù)/gi, '$1 mílíọ̀nù naira')
    .replace(/₦\s*([\d,.]+)\s*(?:billion|bílíọ̀nù)/gi, '$1 bílíọ̀nù naira')
    .replace(/₦\s*([\d,.]+)\s*(?:thousand|ẹgbẹ̀rún)/gi, '$1 ẹgbẹ̀rún naira')
    .replace(/₦\s*([\d,.]+)/g, '$1 naira')
    .replace(/\$\s*([\d,.]+)/g, '$1 dọ́là')
    .replace(/£\s*([\d,.]+)/g, '$1 pọ́ọ̀ǹdù')
    .replace(/€\s*([\d,.]+)/g, '$1 yúró')

    // Magnitudes
    .replace(/\bmillion naira\b/gi, 'mílíọ̀nù naira')
    .replace(/\bbillion naira\b/gi, 'bílíọ̀nù naira')
    .replace(/\bthousand naira\b/gi, 'ẹgbẹ̀rún naira')
    .replace(/\bhundred thousand naira\b/gi, 'ọgọ́rùn-ún ẹgbẹ̀rún naira')
    .replace(/\bmillion\b/gi, 'mílíọ̀nù')
    .replace(/\bbillion\b/gi, 'bílíọ̀nù')
    .replace(/\bthousand\b/gi, 'ẹgbẹ̀rún')
    .replace(/\bhundred\b/gi, 'ọgọ́rùn-ún')

    // Symbols & percentages
    .replace(/%/g, ' pásẹ́ntì')
    .replace(/°C\b/gi, ' degrees Celsius')
    .replace(/\b(?:kilometres|km)\b/gi, 'kílómítà')
    .replace(/\b(?:kilograms|kg)\b/gi, 'kílógíráàmù')
    .replace(/(\d)\s*(?:litres|L)\b/g, '$1 lítà')
    .replace(/\blitres\b/gi, 'lítà')
    .replace(/\bmetres\b/gi, 'mítà')

    // Time & Acronyms
    .replace(/\ba\.m\.\b/gi, 'àárọ̀')
    .replace(/\bp\.m\.\b/gi, 'ọ̀sán')
    .replace(/\b(?:AI|artificial intelligence)\b/gi, 'ọgbọ́n atọwọ́dá')

    // Math & Connectors
    .replace(/\s*&\s*/g, ' àti ')
    .replace(/\s*\+\s*/g, ' àfikún ')
    .replace(/\s*=\s*/g, ' dọ́gba pẹ̀lú ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeIgbo(text: string): string {
  return text
    // Currencies
    .replace(/₦\s*([\d,.]+)\s*(?:million|nde)/gi, '$1 nde naịra')
    .replace(/₦\s*([\d,.]+)\s*(?:billion|ijeri)/gi, '$1 ijeri naịra')
    .replace(/₦\s*([\d,.]+)\s*(?:thousand|puku)/gi, '$1 puku naịra')
    .replace(/₦\s*([\d,.]+)/g, '$1 naịra')
    .replace(/\$\s*([\d,.]+)/g, '$1 dọla')
    .replace(/£\s*([\d,.]+)/g, '$1 paụndụ')
    .replace(/€\s*([\d,.]+)/g, '$1 euro')

    // Magnitudes
    .replace(/\bmillion naira\b/gi, 'nde naịra')
    .replace(/\bbillion naira\b/gi, 'ijeri naịra')
    .replace(/\bthousand naira\b/gi, 'puku naịra')
    .replace(/\bhundred thousand naira\b/gi, 'narị puku naịra')
    .replace(/\bmillion\b/gi, 'nde')
    .replace(/\bbillion\b/gi, 'ijeri')
    .replace(/\bthousand\b/gi, 'puku')
    .replace(/\bhundred\b/gi, 'narị')

    // Symbols & percentages
    .replace(/%/g, ' pasentị')
    .replace(/°C\b/gi, ' degrees Celsius')
    .replace(/\b(?:kilometres|km)\b/gi, 'kilomita')
    .replace(/\b(?:kilograms|kg)\b/gi, 'kilogram')
    .replace(/(\d)\s*(?:litres|L)\b/g, '$1 lita')
    .replace(/\blitres\b/gi, 'lita')
    .replace(/\bmetres\b/gi, 'mita')

    // Time & Acronyms
    .replace(/\ba\.m\.\b/gi, "n'ụtụtụ")
    .replace(/\bp\.m\.\b/gi, "n'ehihie")
    .replace(/\b(?:AI|artificial intelligence)\b/gi, 'ọgụgụ isi aka mmadụ')

    // Math & Connectors
    .replace(/\s*&\s*/g, ' na ')
    .replace(/\s*\+\s*/g, ' gbakwunye ')
    .replace(/\s*=\s*/g, ' hà nhata ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeHausa(text: string): string {
  return text
    // Currencies
    .replace(/₦\s*([\d,.]+)\s*(?:million|miliyan)/gi, '$1 miliyan naira')
    .replace(/₦\s*([\d,.]+)\s*(?:billion|biliyan)/gi, '$1 biliyan naira')
    .replace(/₦\s*([\d,.]+)\s*(?:thousand|dubu)/gi, '$1 dubu naira')
    .replace(/₦\s*([\d,.]+)/g, '$1 naira')
    .replace(/\$\s*([\d,.]+)/g, '$1 dala')
    .replace(/£\s*([\d,.]+)/g, '$1 fam')
    .replace(/€\s*([\d,.]+)/g, '$1 yuro')

    // Magnitudes
    .replace(/\bmillion naira\b/gi, 'miliyan naira')
    .replace(/\bbillion naira\b/gi, 'biliyan naira')
    .replace(/\bthousand naira\b/gi, 'dubu naira')
    .replace(/\bhundred thousand naira\b/gi, 'ɗari dubu naira')
    .replace(/\bmillion\b/gi, 'miliyan')
    .replace(/\bbillion\b/gi, 'biliyan')
    .replace(/\bthousand\b/gi, 'dubu')
    .replace(/\bhundred\b/gi, 'ɗari')

    // Symbols & percentages
    .replace(/%/g, ' kashi')
    .replace(/°C\b/gi, ' digiri Celsius')
    .replace(/(\d+)\s*(?:kilometres|km)\b/gi, '$1 kilomita')
    .replace(/\b(?:kilometres|km)\b/gi, 'kilomita')
    .replace(/(\d+)\s*(?:kilograms|kg)\b/gi, '$1 kilogram')
    .replace(/\b(?:kilograms|kg)\b/gi, 'kilogram')
    .replace(/(\d+)\s*(?:litres|L)\b/g, '$1 lita')
    .replace(/\b(?:litres|L)\b/g, 'lita')
    .replace(/(\d+)\s*m\b/gi, '$1 mita')
    .replace(/\bmetres\b/gi, 'mita')

    // Time & Acronyms
    .replace(/\ba\.m\.\b/gi, 'na safe')
    .replace(/\bp\.m\.\b/gi, 'na yamma')
    .replace(/\b(?:AI|artificial intelligence)\b/gi, 'basirar wucin gadi')

    // Math & Connectors
    .replace(/\s*&\s*/g, ' da ')
    .replace(/\s*\+\s*/g, ' ƙara ')
    .replace(/\s*=\s*/g, ' daidai da ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizePidgin(text: string): string {
  return text
    // Currencies
    .replace(/₦\s*([\d,.]+)\s*(?:m|million)/gi, '$1 million naira')
    .replace(/₦\s*([\d,.]+)\s*(?:b|billion)/gi, '$1 billion naira')
    .replace(/₦\s*([\d,.]+)\s*(?:k|thousand)/gi, '$1 thousand naira')
    .replace(/₦\s*([\d,.]+)/g, '$1 naira')
    .replace(/\$\s*([\d,.]+)/g, '$1 dollars')
    .replace(/£\s*([\d,.]+)/g, '$1 pounds')
    .replace(/€\s*([\d,.]+)/g, '$1 euros')

    // Symbols & percentages
    .replace(/%/g, ' percent')
    .replace(/°C\b/gi, ' degrees Celsius')
    .replace(/\b(?:kilometres|km)\b/gi, 'kilometres')
    .replace(/\b(?:kilograms|kg)\b/gi, 'kilograms')

    // Time & Acronyms
    .replace(/\ba\.m\.\b/gi, 'morning')
    .replace(/\bp\.m\.\b/gi, 'afternoon')
    .replace(/\b(?:AI|artificial intelligence)\b/gi, 'artificial intelligence')

    // Math & Connectors
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\s*=\s*/g, ' equals ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeNigerianEnglish(text: string): string {
  return text
    // Currencies
    .replace(/₦\s*([\d,.]+)\s*million/gi, '$1 million naira')
    .replace(/₦\s*([\d,.]+)\s*billion/gi, '$1 billion naira')
    .replace(/₦\s*([\d,.]+)\s*thousand/gi, '$1 thousand naira')
    .replace(/₦\s*([\d,.]+)/g, '$1 naira')
    .replace(/\$\s*([\d,.]+)/g, '$1 dollars')
    .replace(/£\s*([\d,.]+)/g, '$1 pounds')
    .replace(/€\s*([\d,.]+)/g, '$1 euros')

    // Symbols & percentages
    .replace(/%/g, ' percent')
    .replace(/°C\b/gi, ' degrees Celsius')
    .replace(/\b(?:kilometres|km)\b/gi, 'kilometres')
    .replace(/\b(?:kilograms|kg)\b/gi, 'kilograms')

    // Acronyms
    .replace(/\bAI\b/g, 'artificial intelligence')

    // Math & Connectors
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\s*=\s*/g, ' equals ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

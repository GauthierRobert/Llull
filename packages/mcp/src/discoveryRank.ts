/**
 * `search_tools` ranking: whole-word and name hits outweigh prefix and description hits, rare words (IDF over the
 * tool catalog) outweigh common ones, adjacent query words earn a phrase bonus, and a small phrase / synonym table
 * maps everyday phrasing onto the vocabulary tool names use.
 */
import type { McpToolDefinition } from './tools';

/** Plural-insensitive stem: "edges" -> "edge", "holes" -> "hole", "entities" -> "entity". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(stem);

/** Words that carry no tool meaning in an agent's phrasing. */
const STOPWORDS: ReadonlySet<string> = new Set(
  'a an the in on of to for and or with by at from out it is are be how do does can i me my we you this that what which want need make some all into many between two'.split(
    ' ',
  ),
);

/** Everyday single-word phrasing -> the vocabulary tool names use (weighted below a literal hit). */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  hole: ['boolean', 'subtract', 'cut'],
  drill: ['boolean', 'subtract', 'cut'],
  cut: ['boolean', 'subtract'],
  round: ['fillet'],
  bevel: ['chamfer'],
  hollow: ['shell'],
  heavy: ['mass'],
  weight: ['mass'],
  copy: ['duplicate', 'array'],
  clone: ['duplicate'],
  repeat: ['array'],
  remove: ['delete'],
  resize: ['scale'],
  spin: ['rotate'],
  turn: ['rotate'],
  merge: ['boolean', 'union'],
  join: ['boolean', 'union'],
  combine: ['boolean', 'union'],
  size: ['bounding', 'measure'],
  length: ['measure', 'distance'],
  area: ['measure'],
  overlap: ['check', 'assembly'],
  interference: ['check', 'assembly'],
  clash: ['check', 'assembly'],
  floating: ['check', 'assembly'],
  thickness: ['check', 'assembly'],
  buildable: ['check', 'assembly'],
  save: ['export'],
  load: ['import'],
  picture: ['render'],
  image: ['render'],
  screenshot: ['render'],
  vibration: ['modal', 'frequency'],
  eigenfrequency: ['modal', 'frequency'],
  stiffness: ['fea', 'solve'],
};

/** Engineering phrases (stemmed, in order) -> tool vocabulary; the phrase's words lose their single-word synonyms. */
const PHRASES: readonly { readonly words: readonly string[]; readonly expansion: readonly string[] }[] = [
  { words: ['natural', 'frequency'], expansion: ['modal', 'eigen'] },
  { words: ['cut', 'fill'], expansion: ['earthworks', 'platform', 'volume'] },
  { words: ['pressure', 'drop'], expansion: ['hydraulics', 'pipe'] },
  { words: ['stress', 'plot'], expansion: ['fea', 'results'] },
  { words: ['stress', 'contour'], expansion: ['fea', 'results'] },
  { words: ['head', 'loss'], expansion: ['hydraulics', 'pipe'] },
];

interface QueryTerm {
  readonly word: string;
  /** 1 for a literal query word, lower for a synonym expansion. */
  readonly weight: number;
}

interface ParsedQuery {
  readonly terms: readonly QueryTerm[];
  /** The query's own words (stopwords dropped, no synonyms). */
  readonly literal: readonly string[];
  /** Adjacent literal word pairs, for the phrase bonus. */
  readonly bigrams: readonly (readonly [string, string])[];
}

const SYNONYM_WEIGHT = 0.5;
const PHRASE_EXPANSION_WEIGHT = 0.9;
const PHRASE_WORD_WEIGHT = 0.15; // words of a recognised phrase mean the phrase, not themselves

/** Query terms: stopwords and one-letter words dropped, phrase and synonym expansions appended. */
export function parseQuery(query: string): ParsedQuery {
  const words = tokenize(query).filter((token) => token.length > 1 && !STOPWORDS.has(token));
  const expansions = new Map<string, number>();
  const phraseCovered = new Set<string>();
  for (const phrase of PHRASES) {
    const [first, second] = phrase.words;
    if (first !== undefined && second !== undefined && words.some((w, i) => w === first && words[i + 1] === second)) {
      phrase.expansion.forEach((word) => expansions.set(word, PHRASE_EXPANSION_WEIGHT));
      phrase.words.forEach((word) => phraseCovered.add(word));
    }
  }
  for (const word of words) {
    if (phraseCovered.has(word)) continue;
    for (const synonym of SYNONYMS[word] ?? []) expansions.set(synonym, Math.min(1, (expansions.get(synonym) ?? 0) + SYNONYM_WEIGHT));
  }
  const literal = [...new Set(words)];
  const terms: QueryTerm[] = [
    ...literal.map((word) => ({ word, weight: phraseCovered.has(word) ? PHRASE_WORD_WEIGHT : 1 })),
    ...[...expansions].filter(([word]) => !literal.includes(word)).map(([word, weight]) => ({ word, weight })),
  ];
  const bigrams = words.slice(1).map((word, i) => [words[i] ?? '', word] as const);
  return { terms, literal, bigrams };
}

interface IndexedTool {
  readonly nameWords: readonly string[];
  readonly descriptionWords: readonly string[];
}

interface ToolIndex {
  readonly tools: Map<string, IndexedTool>;
  /** Normalised inverse document frequency in (0, 1]: 1 = appears in one tool, → 0 = in every tool. */
  readonly idf: Map<string, number>;
}

let cached: { readonly size: number; readonly index: ToolIndex } | undefined;

/** The tool index for `all`, rebuilt only when the tool count changes (plugins install once at startup). */
export function toolIndex(all: readonly McpToolDefinition[]): ToolIndex {
  if (cached?.size === all.length) return cached.index;
  const tools = new Map<string, IndexedTool>();
  const documentFrequency = new Map<string, number>();
  for (const tool of all) {
    const nameWords = tokenize(tool.name);
    const descriptionWords = tokenize(tool.description);
    tools.set(tool.name, { nameWords, descriptionWords });
    for (const word of new Set([...nameWords, ...descriptionWords])) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const maxIdf = Math.log(1 + all.length);
  const idf = new Map([...documentFrequency].map(([word, df]) => [word, Math.log(1 + all.length / df) / maxIdf] as const));
  const index = { tools, idf };
  cached = { size: all.length, index };
  return index;
}

const NAME_EXACT = 10;
const NAME_PREFIX = 5;
const NAME_SUBSTRING = 2;
const DESCRIPTION_EXACT = 2;
const DESCRIPTION_PREFIX = 0.8;
const EARLY_WORDS = 12;
const EARLY_BONUS = 1.5;
const TOOLSET_BONUS = 2;
const NAME_LENGTH_PENALTY = 0.04; // at equal relevance the more specific (shorter) name wins
const NAME_EXACT_ALL = 8; // the query words ARE the tool name ("export step" -> export_step)
const NAME_BIGRAM = 8;
const DESCRIPTION_BIGRAM = 3;

/** Prefix matching only for stems of ≥ 5 letters ("hydraul" -> "hydraulics"); "fill" must not match "fillet". */
const prefixMatches = (word: string, token: string): boolean => token.length >= 5 && word.length > token.length && word.startsWith(token);

const hasBigram = (words: readonly string[], [a, b]: readonly [string, string]): boolean =>
  words.some((w, i) => w === a && words[i + 1] === b);

/**
 * Relevance of one tool to a parsed query (0 = no match).
 * Per term, scaled by weight and rarity: name word 10, name prefix 5, name substring 2, description word 2
 * (+1.5 within the first 12 words), description prefix 0.8, toolset name 2. Adjacent query words: +8 in the name, +3 in the description.
 */
export function scoreTool(name: string, toolset: string, query: ParsedQuery, index: ToolIndex): number {
  const indexed = index.tools.get(name);
  if (indexed === undefined) return 0;
  const { nameWords, descriptionWords } = indexed;
  let score = 0;
  for (const { word, weight } of query.terms) {
    const rarity = !query.literal.includes(word) ? 1 : 0.4 + 0.6 * (index.idf.get(word) ?? 1); // curated expansions are trusted
    let hit = 0;
    if (nameWords.includes(word)) hit += NAME_EXACT;
    else if (nameWords.some((w) => prefixMatches(w, word))) hit += NAME_PREFIX;
    else if (word.length >= 4 && name.includes(word)) hit += NAME_SUBSTRING;
    if (toolset === word) hit += TOOLSET_BONUS;
    const position = descriptionWords.indexOf(word);
    if (position >= 0) hit += DESCRIPTION_EXACT + (position < EARLY_WORDS ? EARLY_BONUS : 0);
    else if (descriptionWords.some((w) => prefixMatches(w, word))) hit += DESCRIPTION_PREFIX;
    score += hit * weight * rarity;
  }
  if (nameWords.length === query.literal.length && nameWords.every((word) => query.literal.includes(word))) score += NAME_EXACT_ALL;
  for (const pair of query.bigrams) {
    if (hasBigram(nameWords, pair)) score += NAME_BIGRAM;
    if (hasBigram(descriptionWords, pair)) score += DESCRIPTION_BIGRAM;
  }
  return score / (1 + NAME_LENGTH_PENALTY * nameWords.length);
}

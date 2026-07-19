/**
 * Lightweight lexical tags derived from a memory's text.
 *
 * Lexical, not semantic — the embedding already carries meaning. These exist so
 * the promotion scorer can tell that a memory keeps surfacing around a
 * recurring theme rather than a one-off phrase. They are 6% of the promotion
 * score, so a cheap tokenizer is the right amount of machinery.
 *
 * Its own module because both the write path (vectorStore.embedAndStore) and
 * the scorer's tests need it, and importing across those two directly would
 * make a cycle.
 */

const STOPWORDS = new Set([
  'about', 'after', 'again', 'been', 'before', 'being', 'could', 'didn', 'does',
  'doing', 'down', 'each', 'from', 'have', 'having', 'here', 'himself', 'into',
  'just', 'like', 'more', 'most', 'much', 'myself', 'only', 'other', 'over',
  'really', 'said', 'same', 'should', 'some', 'such', 'than', 'that', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'those',
  'through', 'time', 'very', 'want', 'wanted', 'were', 'what', 'when', 'where',
  'which', 'while', 'with', 'would', 'your', 'yourself',
]);

/**
 * @param {string} content
 * @param {number} [limit=8]
 * @returns {string[]} distinct lowercase tokens, in order of first appearance
 */
export function deriveConceptTags(content, limit = 8) {
  if (!content) return [];
  const seen = new Set();
  for (const token of content.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    const word = token.replace(/^'+|'+$/g, '');
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

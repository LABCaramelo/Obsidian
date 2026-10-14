/**
 * Small search language:
 *   palavra "frase exata" -excluir tag:#projeto path:"Pasta/Sub" file:nome line:(a b) /regex/
 * Terms are AND-ed; matching is case-insensitive unless `matchCase` is set.
 */
export function parseQuery(query) {
  const terms = [];
  const re = /(-)?(?:(tag|path|file|line|section):)?(?:"([^"]*)"|\/((?:\\\/|[^/])+)\/|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const [, neg, op, quoted, regex, word] = m;
    const value = quoted ?? regex ?? word;
    if (value == null || value === '') continue;
    terms.push({ negate: !!neg, op: op || 'content', value, regex: regex != null });
  }
  return terms;
}

function makeMatcher(term, matchCase) {
  if (term.regex) {
    try {
      const re = new RegExp(term.value, matchCase ? 'g' : 'gi');
      return (text) => {
        re.lastIndex = 0;
        return re.test(text);
      };
    } catch {
      return () => false;
    }
  }
  const needle = matchCase ? term.value : term.value.toLowerCase();
  return (text) => (matchCase ? text : text.toLowerCase()).includes(needle);
}

/**
 * Runs a query over notes. `getTags(path)` returns the note's tags.
 * Returns [{ path, matches: [{ line, text, ranges: [[start,end]] }] }].
 */
export function runSearch(query, files, { read, getTags, matchCase = false, maxLinesPerFile = 50 }) {
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const contentTerms = terms.filter((t) => t.op === 'content' && !t.negate);
  const results = [];

  for (const path of files) {
    const text = read(path) ?? '';
    let ok = true;
    for (const term of terms) {
      let hit;
      if (term.op === 'tag') {
        const wanted = term.value.replace(/^#?/, '#').toLowerCase();
        hit = getTags(path).some((t) => t.toLowerCase() === wanted || t.toLowerCase().startsWith(`${wanted}/`));
      } else if (term.op === 'path') {
        hit = makeMatcher(term, matchCase)(path);
      } else if (term.op === 'file') {
        hit = makeMatcher(term, matchCase)(path.split('/').pop());
      } else {
        // content, line and section all look inside the text
        hit = makeMatcher(term, matchCase)(text) || (term.op === 'content' && makeMatcher(term, matchCase)(path.split('/').pop()));
      }
      if (hit === term.negate) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const matches = [];
    if (contentTerms.length) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxLinesPerFile; i++) {
        const ranges = [];
        for (const term of contentTerms) ranges.push(...findRanges(lines[i], term, matchCase));
        if (ranges.length) matches.push({ line: i, text: lines[i], ranges: ranges.sort((a, b) => a[0] - b[0]) });
      }
    }
    results.push({ path, matches });
  }
  return results;
}

function findRanges(line, term, matchCase) {
  const ranges = [];
  if (term.regex) {
    try {
      const re = new RegExp(term.value, matchCase ? 'g' : 'gi');
      for (const m of line.matchAll(re)) if (m[0]) ranges.push([m.index, m.index + m[0].length]);
    } catch {
      /* invalid regex */
    }
    return ranges;
  }
  const hay = matchCase ? line : line.toLowerCase();
  const needle = matchCase ? term.value : term.value.toLowerCase();
  let i = hay.indexOf(needle);
  while (i !== -1 && needle) {
    ranges.push([i, i + needle.length]);
    i = hay.indexOf(needle, i + needle.length);
  }
  return ranges;
}

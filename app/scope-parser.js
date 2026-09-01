function expandNumericRange(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
}

function requestedItems(fragment) {
  if (/본문\s*전체|전체\s*본문/i.test(fragment)) return null;
  const until = fragment.match(/본문\s*(\d+)\s*까지/);
  if (until) return expandNumericRange(1, Number(until[1]));
  const cleaned = fragment.replace(/^.*?:/, " ")
    .replace(/(?:20)?\d{2}\s*년/g, " ")
    .replace(/\d{1,2}\s*월/g, " ")
    .replace(/\d+\s*(?:과|강)/g, " ");
  const values = [];
  for (const match of cleaned.matchAll(/(\d+)\s*[~～]\s*(\d+)/g)) values.push(...expandNumericRange(Number(match[1]), Number(match[2])));
  for (const match of cleaned.matchAll(/(\d+)\s*-\s*(\d+)/g)) {
    const start = Number(match[1]); const end = Number(match[2]);
    if (start <= end) values.push(...expandNumericRange(start, end));
    else values.push(`${start}-${end}`);
  }
  const withoutRanges = cleaned.replace(/\d+\s*[~～-]\s*\d+/g, " ");
  for (const match of withoutRanges.matchAll(/\d+/g)) values.push(String(Number(match[0])));
  let unique = [...new Set(values)].filter((value) => value !== "0");
  if (/짝수(?:\s*번호)?만/.test(fragment)) unique = unique.filter((value) => Number(value) % 2 === 0);
  if (/홀수(?:\s*번호)?만/.test(fragment)) unique = unique.filter((value) => Number(value) % 2 === 1);
  for (const match of fragment.matchAll(/(\d+)\s*\(\s*두\s*개\s*\)/g)) if (unique.includes(String(Number(match[1])))) unique.push(String(Number(match[1])));
  return unique.length ? unique : null;
}

export function parseWorkbookScope(scope) {
  const matches = [...scope.matchAll(/(\d+)\s*과/g)];
  if (!matches.length) return [{ sectionIndex: 1, items: requestedItems(scope) }];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? scope.length;
    return { sectionIndex: Number(match[1]), items: requestedItems(scope.slice(start, end)) };
  });
}

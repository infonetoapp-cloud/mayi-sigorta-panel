function fold(v: string) {
  return v
    .normalize('NFKC')
    .replace(/[İIı]/g, 'i')
    .replace(/[Şş]/g, 's')
    .replace(/[Ğğ]/g, 'g')
    .replace(/[Üü]/g, 'u')
    .replace(/[Öö]/g, 'o')
    .replace(/[Çç]/g, 'c')
    .toLowerCase();
}
function foldSql(v: string) {
  for (const [a, b] of [
    ['İ', 'i'],
    ['I', 'i'],
    ['ı', 'i'],
    ['Ş', 's'],
    ['ş', 's'],
    ['Ğ', 'g'],
    ['ğ', 'g'],
    ['Ü', 'u'],
    ['ü', 'u'],
    ['Ö', 'o'],
    ['ö', 'o'],
    ['Ç', 'c'],
    ['ç', 'c'],
  ])
    v = `replace(${v},'${a}','${b}')`;
  return `lower(${v})`;
}
// Pair the folded query with a bound parameter. Only pass static SQL expressions.
export function literalTurkishSearch(column: string, query: string) {
  return { predicate: `instr(${foldSql(column)}, ?) > 0`, needle: fold(query) };
}

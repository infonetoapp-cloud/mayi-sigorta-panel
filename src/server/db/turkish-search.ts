const turkishLetters = [
  ['İ', 'i'],
  ['I', 'ı'],
  ['Ç', 'ç'],
  ['Ğ', 'ğ'],
  ['Ö', 'ö'],
  ['Ş', 'ş'],
  ['Ü', 'ü'],
] as const;

export function turkishNameSql(column: 'display_name' | 'c.display_name') {
  // Column names are source literals. The user's search term is always bound separately.
  const folded = turkishLetters.reduce<string>(
    (expression, [upper, lower]) => `replace(${expression},'${upper}','${lower}')`,
    column,
  );
  return `lower(${folded})`;
}

export function turkishNameTerm(term: string) {
  return term.normalize('NFC').toLocaleLowerCase('tr-TR');
}

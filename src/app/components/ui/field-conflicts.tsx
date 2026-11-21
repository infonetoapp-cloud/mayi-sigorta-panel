export type ConflictChoice = 'current' | 'draft';
export type ConflictChoices = Partial<Record<string, ConflictChoice>>;

export function compareEdits<T extends Record<string, string>>(
  original: T,
  draft: T,
  current: T,
  choices: ConflictChoices,
) {
  const merged = { ...current };
  const conflicts: { name: string; current: string; draft: string }[] = [];
  for (const key of Object.keys(original) as Array<keyof T & string>) {
    if (draft[key] === original[key]) continue;
    if (current[key] !== original[key] && current[key] !== draft[key]) {
      conflicts.push({ name: key, current: current[key]!, draft: draft[key]! });
      if (choices[key] !== 'draft') continue;
    }
    merged[key] = draft[key];
  }
  return { merged, conflicts, resolved: conflicts.every(({ name }) => choices[name]) };
}

export function FieldConflictChoices({
  conflicts,
  choices,
  labels,
  onChange,
  format = (_name, value) => value || 'Boş',
}: {
  conflicts: { name: string; current: string; draft: string }[];
  choices: ConflictChoices;
  labels: Record<string, string>;
  onChange: (name: string, choice: ConflictChoice) => void;
  format?: (name: string, value: string) => string;
}) {
  if (!conflicts.length) return null;
  return (
    <fieldset>
      <legend>İki kişinin değiştirdiği alanlar</legend>
      {conflicts.map(({ name, current, draft }) => (
        <label key={name}>
          {labels[name]} için kullanılacak değer
          <select
            value={choices[name] ?? ''}
            onChange={(event) => onChange(name, event.target.value as ConflictChoice)}
          >
            <option value="" disabled>
              Değer seçin
            </option>
            <option value="current">Güncel kayıt · {format(name, current)}</option>
            <option value="draft">Taslağım · {format(name, draft)}</option>
          </select>
        </label>
      ))}
    </fieldset>
  );
}

import { createInterface } from 'node:readline/promises';
const { AbortController } = globalThis;

export function parseDemoArguments(args) {
  if (args.length === 0) return { visibleInput: false };
  if (args.length === 1 && args[0] === '--visible-input') return { visibleInput: true };
  throw new Error('DEMO_ARGUMENTS_INVALID');
}

/** Only synthetic, disposable local demo credentials. Never accepts credential
 * arguments or persists/logs answers. terminal:false leaves Windows cooked line
 * input in charge: no raw mode, keypress listener or custom editing in this path. */
export async function readDemoPasswords(users, { visibleInput, input, output, masked }) {
  output.write(
    '\nYalnız sentetik, geçici yerel demo. Gerçek hesap parolanızı KULLANMAYIN.\nHer hesap için en az 15 karakterlik ayrı bir demo parolası girin.\n',
  );
  if (visibleInput)
    output.write(
      'UYARI: --visible-input seçildi. Parolalar yerel terminalde GÖRÜNÜR olacaktır; ekran paylaşımı, terminal kaydı/transcript veya omuz üzerinden izleme varken kullanmayın. Yalnız sentetik demo parolaları girin.\n',
    );
  else output.write('Maskeli giriş: girdi görünmez.\n');
  const reader = visibleInput ? createInterface({ input, output, terminal: false }) : undefined;
  const controller = new AbortController();
  reader?.once('close', () => controller.abort());
  const ask = reader
    ? (prompt) =>
        reader.question(prompt, { signal: controller.signal }).catch(() => {
          throw new Error('Demo kurulumu iptal edildi.');
        })
    : masked;
  const passwords = [];
  try {
    for (const user of users) {
      const value = await ask(`${user.name} (${user.email}) parolası: `);
      const confirmation = await ask('Tekrar: ');
      if (value !== confirmation) throw new Error('Parolalar eşleşmedi; baştan başlatın.');
      const length = Array.from(value.normalize('NFC')).length;
      if (value.length > 256 || length < 15 || length > 128)
        throw new Error('Parola 15–128 Unicode karakteri olmalıdır.');
      passwords.push(value);
    }
    if (
      passwords.length !== 3 ||
      new Set(passwords.map((value) => value.normalize('NFC'))).size !== 3
    )
      throw new Error('Üç farklı demo parolası kullanın.');
    return passwords;
  } catch (error) {
    passwords.fill('');
    throw error;
  } finally {
    reader?.close();
    if (reader) input.pause();
  }
}

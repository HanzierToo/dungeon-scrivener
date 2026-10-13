/** Authoring syntax only. JSON stores each command phrase as a separate string. */
export function parsePatternInput(input: string): string[] {
  const phrases: string[] = [];
  let phrase = '';
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === '\\' && /[\\,|]/u.test(input[index + 1] ?? '')) {
      phrase += input[++index];
    } else if (character === ',' || character === '|') {
      if (phrase.trim()) phrases.push(phrase.trim());
      phrase = '';
    } else phrase += character;
  }
  if (phrase.trim()) phrases.push(phrase.trim());
  return phrases;
}

export function formatPatternInput(phrases: readonly string[]): string {
  return phrases.map(phrase => phrase.replace(/[\\,|]/gu, character => `\\${character}`)).join(' | ');
}

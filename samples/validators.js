// 入力バリデータ集(正規表現まみれ)
const PATTERNS = {
  email: /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)*$/,
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  isoDate: /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T[01]\d|2[0-3]:[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-][01]\d:[0-5]\d))?$/,
  phoneJp: /^0\d{1,4}-?\d{1,4}-?\d{3,4}$/,
  hexColor: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i,
  semver: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*))?$/,
};

export function validate(kind, value) {
  const re = PATTERNS[kind];
  if (!re) throw new Error(`unknown kind: ${kind}`);
  return re.test(String(value).trim());
}

export function extractAll(text) {
  const found = {};
  for (const [kind, re] of Object.entries(PATTERNS)) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    found[kind] = [...text.matchAll(g)].map((m) => m[0]);
  }
  return found;
}
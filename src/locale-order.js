const collators = new Map();

function localeFromEnvironment(environment = process.env) {
  const raw = environment.LC_ALL || environment.LC_COLLATE || environment.LANG || "en-US";
  const base = String(raw).split(".", 1)[0].split("@", 1)[0];
  if (!base || base === "C" || base === "POSIX") return "en-US";
  const candidate = base.replaceAll("_", "-");
  try {
    return Intl.getCanonicalLocales(candidate)[0] || "en-US";
  } catch {
    return "en-US";
  }
}

export function compareStringsForEnvironment(left, right, environment = process.env) {
  const locale = localeFromEnvironment(environment);
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale);
    collators.set(locale, collator);
  }
  return collator.compare(String(left), String(right));
}

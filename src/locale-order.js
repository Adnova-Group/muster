const collators = new Map();

function localeFromEnvironment(environment = process.env) {
  // Match Node/ICU's startup locale precedence so worker-thread ordering stays
  // byte-equivalent to the legacy child process even when category-specific
  // locale variables conflict.
  const raw = environment.LC_ALL || environment.LC_MESSAGES || environment.LANG || "en-US";
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

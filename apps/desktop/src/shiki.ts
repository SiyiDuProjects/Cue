// The code block component imports "shiki", which loads every grammar on
// demand. The Mac WebView runs one bundled script from file://, where those
// dynamic imports fail, so the build points "shiki" here instead: the two
// themes the component asks for and the languages interview answers use.
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import go from "@shikijs/langs/go";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import kotlin from "@shikijs/langs/kotlin";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";

const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [githubLight, githubDark],
  langs: [
    c,
    cpp,
    csharp,
    go,
    java,
    javascript,
    json,
    kotlin,
    python,
    rust,
    shellscript,
    sql,
    swift,
    typescript,
    yaml,
  ],
});
const languages = new Set(highlighter.getLoadedLanguages());

type Options = Parameters<typeof highlighter.codeToHtml>[1];
export async function codeToHtml(code: string, options: Options) {
  const lang = languages.has(options.lang as string) ? options.lang : "text";
  return highlighter.codeToHtml(code, { ...options, lang } as Options);
}

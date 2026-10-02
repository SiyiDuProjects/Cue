import assert from "node:assert/strict";
import React from "react";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerMarkdown } from "../src/AnswerMarkdown";

function render(text: string, streaming = true) {
  return renderToStaticMarkup(<AnswerMarkdown text={text} streaming={streaming} />);
}

test("streaming prose uses standard Markdown without rewriting unfinished content", () => {
  assert.match(render("先看 **关键观察"), /先看 \*\*关键观察/);
  assert.match(render("我们使用 `next_state"), /`next_state/);
  assert.match(render("**重点**：使用 `next_state`"), /<strong>重点<\/strong>/);
  assert.match(render("next_state 保留原名"), /next_state 保留原名/);
});

test("all Markdown code forms preserve the same code text at every stream prefix", () => {
  const examples = [
    '~~~python\nresult = "**literal\nreturn "[link](incomplete"\nif a <b\n~~~\n\n**after',
    '````python\nresult = "```"\nreturn "[link](incomplete"\n````\n\n**after',
    '    result = "**literal\n    return "[link](incomplete"\n    if a <b\n\n**after',
    '\tresult = "**literal\n\treturn "[link](incomplete"\n\tif a <b\n\n**after',
    '> ~~~python\n> result = "**literal\n> return "[link](incomplete"\n> ~~~\n\n**after',
    '- code:\n\n      result = "**literal\n      return "[link](incomplete"\n\n**after',
    'We keep ``a ` ** literal`` and `return "[link](incomplete"` unchanged.\n\n**after',
  ];
  const codeContents = (markup: string) => [...markup.matchAll(/<code(?: [^>]*)?>([\s\S]*?)<\/code>/g)].map((match) => match[1]);
  for (const example of examples) {
    for (let length = 0; length <= example.length; length += 1) {
      const prefix = example.slice(0, length);
      assert.deepEqual(codeContents(render(prefix)), codeContents(render(prefix, false)), JSON.stringify(prefix));
    }
    assert.match(render(example), /\*\*after/);
  }
});

test("appending prose never rewrites previously displayed code or comparisons", () => {
  const source = '~~~python\nresult = "**literal"\n~~~\n\n查看 [资料](https://example.com/pa';
  const markup = render(source);
  assert.match(markup, /result = &quot;\*\*literal&quot;/);
  assert.doesNotMatch(markup, /href=/);
  assert.match(render('    if a <b'), /if a &lt;b/);
  assert.match(render('    return "[link](incomplete'), /return &quot;\[link\]\(incomplete/);
});

test("finished or interrupted Markdown is rendered from its original text", () => {
  assert.match(render("保留 **尚未完成", false), /保留 \*\*尚未完成/);
  assert.doesNotMatch(render("保留 **尚未完成", false), /<strong>/);
});

test("unfinished links never create a partial destination while complete links remain useful", () => {
  const explicit = render("查看 [资料](https://example.com/pa");
  assert.match(explicit, /资料/);
  assert.doesNotMatch(explicit, /<a |href=|streamdown:/);
  assert.doesNotMatch(render("参考 https://example.com/pa"), /<a |href=/);
  assert.match(render("参考 https://example.com/path "), /href="https:\/\/example.com\/path"/);
  assert.match(render("查看 [资料](https://example.com/path)"), /href="https:\/\/example.com\/path"/);
  assert.match(render("参考 https://example.com/path", false), /href="https:\/\/example.com\/path"/);
});

test("fenced code is not completed or rewritten as Markdown", () => {
  const source = '```python\ndef solve(next_state):\n    return "**literal", "[link](incomplete", next_state < 3';
  const markup = render(source);
  assert.match(markup, /def solve\(next_state\):/);
  assert.match(markup, /\*\*literal/);
  assert.match(markup, /\[link\]\(incomplete/);
  assert.match(markup, /next_state &lt; 3/);
  assert.doesNotMatch(markup, /<strong>|<a /);
  assert.match(markup, /aria-label="复制代码"/);
  assert.match(markup, /tabindex="0" aria-label="python 代码"/);
});

test("every prefix of common answer formatting is safe to render", () => {
  const answer = '先看 **关键观察**，保存 `next_state`。\n\n[资料](https://example.com/docs)\n\n```python\nresult = "**literal"\n```\n\n| 输入 | 输出 |\n| --- | --- |\n| 2 | true |';
  for (let length = 0; length <= answer.length; length += 1) {
    const markup = render(answer.slice(0, length));
    assert.doesNotMatch(markup, /<script|<img|streamdown:/);
  }
});

test("stream completion never bypasses existing HTML image or URL restrictions", () => {
  for (const streaming of [true, false]) {
    const markup = render('<script>alert(1)</script>\n\n![tracking](https://example.com/tracker)\n\n[bad](javascript:alert(1)) [file](file:///secret) [auth](https://user:pass@example.com)', streaming);
    assert.doesNotMatch(markup, /<script|<img|<a |href=/);
  }
});

test("inline and display formulas render without interpreting code or escaped dollars", () => {
  const markup = render('时间 $O(n \\log n)$。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$');
  assert.match(markup, /class="katex"/);
  assert.match(markup, /class="katex-display"/);
  assert.match(markup, /<math /);
  assert.doesNotMatch(render('`$x$`\n\n```python\nprice = "$x$"\n```\n\n\\$5'), /class="katex/);
  assert.match(render('`$x$`'), /<code[^>]*>\$x\$<\/code>/);
  assert.match(render('> $$\n> x^2\n> $$'), /class="katex-display"/);
});

test("partial and interrupted formula fences remain literal until closed", () => {
  const partial = '$$\n\\frac{n(n+1)}{2}';
  for (const streaming of [true, false]) {
    const markup = render(partial, streaming);
    assert.doesNotMatch(markup, /class="katex/);
    assert.match(markup, /\$\$/);
    assert.doesNotMatch(render('$O(n \\log', streaming), /class="katex/);
    const mixed = render('> Already $x$.\n>\n> $$\n> x^2', streaming);
    assert.match(mixed, /class="katex"/);
    assert.doesNotMatch(mixed, /class="katex-display"/);
    assert.match(mixed, /\$\$/);
  }
  assert.match(render(partial + '\n$$'), /class="katex-display"/);
});

test("formula errors and untrusted commands cannot enable links, images or HTML", () => {
  const source = '$\\href{javascript:alert(1)}{bad}$ $\\includegraphics{https://example.com/tracker}$\n\n$\\unknown{broken}$\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/tracker)';
  const markup = render(source);
  assert.doesNotMatch(markup, /<script|<img|<a |href=/);
  assert.match(markup, /\\unknown/);
});

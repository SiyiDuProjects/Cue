// Deliberately fictional, local-only fixtures. They never enter the live session.
export type PreviewFile = { name: string; code: string; partial?: boolean };
export type PreviewStep = { title: string; changes: Record<string, string> };
export type PreviewScenario = {
  id: string; label: string; title: string; analysis: string;
  answers: { id: string; label: string; text: string }[];
  files: PreviewFile[]; steps: PreviewStep[]; followup: string;
};

const formatter = `class PromptFormatter:
    def __init__(self, parameters):
        self.parameters = dict(parameters)

    def format(self, prompt):
        pass`;
const simpleFormatter = `class PromptFormatter:
    def __init__(self, parameters):
        self.parameters = dict(parameters)

    def format(self, prompt):
        # 我们按百分号分段，奇数位置就是参数名
        parts = prompt.split("%")
        for index in range(1, len(parts), 2):
            parameter_name = parts[index]
            parts[index] = self.parameters[parameter_name]
        return "".join(parts)`;
const resolver = `def resolve_value(name, parameters, visiting):
    # 当前递归路径再次遇到同一个名字，就说明形成了环
    if name in visiting:
        raise ValueError("Circular reference: " + name)

    # 缺少参数时，保留 Python 的 KeyError 语义
    value = parameters[name]
    visiting.add(name)
    try:
        parts = value.split("%")
        for index in range(1, len(parts), 2):
            # 我们继续展开当前参数中引用的其他参数
            parts[index] = resolve_value(
                parts[index], parameters, visiting
            )
        return "".join(parts)
    finally:
        # 离开当前路径后，其他分支仍然可以引用这个参数
        visiting.remove(name)`;
const finalFormatter = `from resolver import resolve_value


class PromptFormatter:
    def __init__(self, parameters):
        self.parameters = dict(parameters)

    def format(self, prompt):
        parts = prompt.split("%")
        for index in range(1, len(parts), 2):
            parameter_name = parts[index]
            # 每次展开从一条新的递归路径开始
            parts[index] = resolve_value(
                parameter_name, self.parameters, set()
            )
        return "".join(parts)`;

export const scenarios: PreviewScenario[] = [
  {
    id: "ood", label: "OOD · 多文件", title: "Prompt Formatter",
    analysis: `## 让参数替换支持嵌套引用

给定一组参数，把文本中的 \`%NAME%\` 替换成对应值。同一个 formatter 可以处理多个 prompt；参数值本身也可能引用其他参数。

### 已确认
- 不使用正则表达式。
- 参数在创建对象时提供，之后保持不变。
- 检测循环引用，缺少参数时抛出错误。

### 还需要确认
暂按成对的百分号、字符串参数处理。若支持不完整占位符或转义百分号，需要再确定语义。

### 职责怎么分
| 文件 | 职责 |
| --- | --- |
| formatter.py | 保存参数，处理完整 prompt |
| resolver.py | 展开单个参数，检测递归路径中的环 |
| test_formatter.py | 覆盖嵌套、重复引用和环 |

### 关键观察
参数之间的引用是一张有向图。检测环要记录**当前路径**，不能只用全局 visited：不同分支重复引用同一个参数是合法的。

先实现普通替换，再加入引用展开，最后连接两个模块并补充验证用例。展开后的文本可能很长，复杂度需要计入实际展开量。`,
    answers: [
      { id: "ood-1", label: "先确认边界", text: "可以先确认两件事：**缺少参数时怎么办？循环引用是否需要报错？**\n\n这两点会影响 resolver 的接口。暂时不用增加 storage 或其他抽象，参数只在内存里保存。" },
      { id: "ood-2", label: "关于类的职责", text: "让 `PromptFormatter` 负责完整文本的格式化，把“展开一个参数”交给 `resolve_value`。这样新增嵌套引用时，外部的 `format(prompt)` 接口不变。" },
      { id: "ood-3", label: "当前讨论", text: "**这里的 visiting 表示当前递归路径，不是所有处理过的参数。**\n\n例如 `A → B → A`：第二次遇到 A 时，它还在路径中，所以报错。\n\n但 `%B% and %B%` 不应该报错。第一次展开 B 结束后，就把 B 从路径移除，第二次仍然可以正常展开。\n\n可以这样口述：\n> 我们记录这一次展开正在经过哪些参数。只有在同一条路径上再次遇到自己，才构成循环。" },
    ],
    files: [
      { name: "formatter.py", code: formatter },
      { name: "resolver.py", code: "def resolve_value(name, parameters, visiting):\n    pass" },
    ],
    steps: [
      { title: "普通参数替换", changes: { "formatter.py": simpleFormatter } },
      { title: "递归展开与循环检测", changes: { "resolver.py": resolver } },
      { title: "接入 formatter", changes: { "formatter.py": finalFormatter } },
      { title: "边界用例", changes: { "test_formatter.py": `from formatter import PromptFormatter


def test_nested_and_repeated_references():
    formatter = PromptFormatter({"NAME": "Ada", "USER": "%NAME%"})
    assert formatter.format("Hi %USER%") == "Hi Ada"
    assert formatter.format("%USER% and %USER%") == "Ada and Ada"


def test_circular_reference():
    formatter = PromptFormatter({"A": "%B%", "B": "%A%"})
    try:
        formatter.format("%A%")
    except ValueError:
        return
    raise AssertionError("Expected a circular-reference error")` } },
    ],
    followup: "如果参数初始化后不会变化，可以缓存已经展开的结果。不过先确认输入规模：当前这版已经能处理嵌套和环，缓存是接下来的优化，不需要改公开接口。",
  },
  {
    id: "algorithm", label: "算法 · 单文件", title: "角色共同出演统计",
    analysis: `## 按同一歌手配对，再累计角色关系

输入是 \`[歌手, 角色, 年份]\` 的记录，以及年份差上限 period。输出每个角色与其他角色在规定时间内共同出现的次数。

### 关键观察
只有**同一歌手**的记录可以配对。年份差恰好等于 period 也满足条件；没有共同出现对象的角色仍要保留。

### 先澄清计数单位
如果同一个歌手多次演出同一角色，是按演出记录对计数，还是每位歌手只记一次？这里暂按记录对计数，不把这个假设写成已确认要求。

### 方案
先按歌手分组，然后枚举组内两条记录。角色不同且年份差在范围内，就给两边各加一。

时间为各组大小平方之和，最坏 O(N²)。输出关系本身可能很多；规模扩大时，再讨论排序和滑动窗口减少无效比较。`,
    answers: [{ id: "lc-1", label: "理解题意", text: "这题的关键是**先按歌手分组**。不能直接比较所有角色，否则会把不同歌手的两场演出算成共同出现。\n\n输出是双向的：A 和 B 满足条件时，A 的结果里增加 B，B 的结果里也增加 A。" }, { id: "lc-2", label: "口述方案", text: "先创建每个角色的空结果，保证没有配对的角色也会出现。接着按歌手收集 `(role, year)`，在每组里枚举 `left < right`，这样同一记录对只处理一次。\n\n例如 Alice 在 2010 年演 A、2013 年演 B，period 为 3，年份差正好等于边界，也应该计入。" }],
    files: [{ name: "solution.py", code: "def cooccurrences(performances, period):\n    pass" }],
    steps: [
      { title: "按歌手分组", changes: { "solution.py": `def cooccurrences(performances, period):
    by_singer = {}
    result = {}

    for singer, role, year in performances:
        # 没有配对的角色也要出现在最终结果中
        result.setdefault(role, {})
        by_singer.setdefault(singer, []).append((role, int(year)))

    return result` } },
      { title: "枚举与双向计数", changes: { "solution.py": `def cooccurrences(performances, period):
    by_singer = {}
    result = {}

    for singer, role, year in performances:
        result.setdefault(role, {})
        by_singer.setdefault(singer, []).append((role, int(year)))

    for records in by_singer.values():
        for left in range(len(records)):
            for right in range(left + 1, len(records)):
                first_role, first_year = records[left]
                second_role, second_year = records[right]
                if first_role == second_role:
                    continue
                if abs(first_year - second_year) > period:
                    continue
                # 两边都记录，但每一对演出只访问一次
                result[first_role][second_role] = (
                    result[first_role].get(second_role, 0) + 1
                )
                result[second_role][first_role] = (
                    result[second_role].get(first_role, 0) + 1
                )

    return result` } },
    ],
    followup: "如果 interviewer 说每位歌手对一对角色最多贡献一次，需要在组内增加一个已计数的角色对集合。这是计数语义变化，先确认，再更新代码。",
  },
  {
    id: "conversation", label: "简历 / BQ · 讨论", title: "项目经历深挖", analysis: "", files: [], steps: [],
    answers: [{ id: "cv-1", label: "说明你的判断", text: "面试官追问“为什么当时没有使用消息队列”，可以从**当时的需求、可选方案、最终取舍**三个方面讲。\n\n先说当时是否真的需要异步，再解释引入队列会增加哪些复杂度。不要只说“当时规模小”，需要把规模和实际问题联系起来。" }, { id: "cv-2", label: "准备应对追问", text: "如果被问“后来规模增长了怎么办”，可以把当时的选择和后续演进分开：\n\n1. 当时为什么选同步处理。\n2. 出现什么信号后，需要改变。\n3. 改成异步后，如何处理重试与重复消息。" }],
    followup: "继续追问时，可以先聚焦一个具体决策。说明你亲自做了什么、怎样验证结果，以及如果重来会调整什么。",
  },
];

export function projectFile(scenario: PreviewScenario, stepIndex: number, filename: string) {
  const actual = scenario.files.find(file => file.name === filename);
  let before = actual?.code ?? "";
  for (let index = 0; index < stepIndex; index++) before = scenario.steps[index].changes[filename] ?? before;
  const step = scenario.steps[stepIndex];
  return { before, after: step?.changes[filename] ?? before, changed: Boolean(step && filename in step.changes), partial: actual?.partial ?? false };
}

export function scenarioFiles(scenario: PreviewScenario) {
  return [...new Set([...scenario.files.map(file => file.name), ...scenario.steps.flatMap(step => Object.keys(step.changes))])];
}

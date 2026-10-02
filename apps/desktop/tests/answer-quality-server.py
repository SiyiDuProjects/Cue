"""Synthetic streamed math/code answers through the real product UI, no provider."""
import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("chat_quality_fixture", Path(__file__).with_name("chat-audit-server.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
original_provider = fixture.provider

ANSWER = r'''先讲清思路，再给完整代码。这是一段足够长的中文说明，用来检查手机上的正文是否使用完整的回答宽度，左右边距应该一致，不能在右侧额外空出一条。

时间复杂度为 $O(n \log n)$，空间复杂度为 $O(n)$。

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

```python
def solve(values: list[int], include_duplicates: bool = True) -> list[int]:
    # 原始代码中的公式标记不应被渲染。
    marker = "$x$"
    return sorted(values)
```

| 输入 | 结果 |
| --- | --- |
| `[3, 1, 2]` | `[1, 2, 3]` |

公式、代码和中文解释应该保持清楚。'''

async def provider(inputs):
    result = await original_provider(inputs)
    return {**result, "text": ANSWER, "chunk_delay": 0.015, "chunk_size": 12}

fixture.provider = provider

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(fixture.app, host="127.0.0.1", port=int(os.environ["AUDIT_PORT"]), log_level="warning")

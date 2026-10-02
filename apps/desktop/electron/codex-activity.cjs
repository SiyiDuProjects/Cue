// Display only native operation metadata, never command output, tool arguments,
// credentials or model reasoning. Completion describes the tool, not code quality.
const clean = value => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0,160);
const basename = value => clean(value).split(/[\\/]/).pop();

function activityFor(item, completed) {
  if (!item?.id) return null;
  let label, kind;
  switch (item.type) {
    case "commandExecution": {
      kind = "command";
      const actions = item.commandActions || [];
      label = actions.length && actions.every(a => a.type === "read")
        ? `读取 ${actions.map(a => basename(a.path || a.name)).filter(Boolean).join("、")}`
        : actions.some(a => a.type === "search") ? "搜索文件内容"
        : actions.some(a => a.type === "listFiles") ? "查看文件列表" : "执行命令";
      break;
    }
    case "webSearch": kind = "search"; label = "检索网页"; break;
    case "imageView": kind = "image"; label = `查看图片 ${basename(item.path)}`; break;
    case "fileChange": kind = "file"; label = "修改文件"; break;
    case "contextCompaction": kind = "context"; label = "整理会话上下文"; break;
    default: return null;
  }
  const failed = item.success === false || ["failed", "declined"].includes(item.status) ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  return { id: clean(item.id), kind, label: clean(label),
    status: completed ? (failed ? "failed" : "completed") : "running" };
}

module.exports = { activityFor };

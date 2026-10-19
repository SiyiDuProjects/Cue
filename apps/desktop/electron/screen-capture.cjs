const MAX_SCREENSHOT_BYTES = 2_621_440;
const MAX_SCREENSHOT_DIMENSION = 1920;

function createScreenCaptureService(
  desktopCapturer,
  screen,
  getOwnWindows = () => [],
) {
  let selectedSourceId = null;
  let captureReaders = 0;
  let protectionReady = null;
  let protectedWindows = [];

  async function withoutOwnWindows(capture) {
    if (process.platform !== "win32") return capture();
    captureReaders += 1;
    try {
      if (captureReaders === 1) {
        for (const window of getOwnWindows()) {
          if (window.isDestroyed() || window.isContentProtected()) continue;
          window.setContentProtection(true);
          protectedWindows.push(window);
        }
        // Windows applies exclusion on the next desktop composition, not on
        // return from setContentProtection. Keep it active through thumbnail capture.
        protectionReady = protectedWindows.length
          ? new Promise((resolve) => setTimeout(resolve, 150))
          : Promise.resolve();
      }
      await protectionReady;
      return await capture();
    } finally {
      // Source previews and snapshots may overlap. Restore only after both end.
      captureReaders -= 1;
      if (captureReaders === 0) {
        const windows = protectedWindows;
        protectedWindows = [];
        protectionReady = null;
        for (const window of windows) {
          if (!window.isDestroyed()) window.setContentProtection(false);
        }
      }
    }
  }

  async function getSources(thumbnailSize, types = ["screen", "window"]) {
    const capture = () =>
      desktopCapturer.getSources({
        types,
        thumbnailSize,
        fetchWindowIcons: false,
      });
    const sources =
      thumbnailSize.width && thumbnailSize.height
        ? await withoutOwnWindows(capture)
        : await capture();
    const ownIds = new Set(
      getOwnWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getMediaSourceId()),
    );
    return sources.filter((source) => !ownIds.has(source.id));
  }

  function primaryScreen(sources) {
    const screens = sources.filter((source) => source.id.startsWith("screen:"));
    const primaryId = String(screen.getPrimaryDisplay().id);
    return (
      screens.find((source) => String(source.display_id) === primaryId) ||
      (screens.length === 1 ? screens[0] : undefined)
    );
  }

  async function listSources() {
    const sources = await getSources({ width: 320, height: 200 });
    const effectiveSourceId = selectedSourceId ?? primaryScreen(sources)?.id;
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id || "",
      thumbnailDataUrl: source.thumbnail.isEmpty()
        ? ""
        : source.thumbnail.toDataURL(),
      selected: source.id === effectiveSourceId,
    }));
  }

  async function selectSource(sourceId) {
    if (typeof sourceId !== "string" || !sourceId || sourceId.length > 1024) {
      throw new Error("请选择有效的屏幕或窗口。");
    }
    const sources = await getSources({ width: 0, height: 0 });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error("选择的屏幕或窗口已不可用，请重新选择。");
    selectedSourceId = source.id;
    return { id: source.id, name: source.name };
  }

  async function captureSnapshot() {
    // Start with the primary monitor; an explicit selection never falls back.
    const sourceId = selectedSourceId;
    const sources = await getSources({
      width: MAX_SCREENSHOT_DIMENSION,
      height: MAX_SCREENSHOT_DIMENSION,
    });
    if (selectedSourceId !== sourceId)
      throw new Error("截图来源已改变，请重新看题。");
    const source = sourceId
      ? sources.find((candidate) => candidate.id === sourceId)
      : primaryScreen(sources);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(
        "屏幕或窗口无法截图，请在电脑端「更多 → 截图来源」中重新选择。",
      );
    }
    const capturedAt = new Date().toISOString();
    let prepared = source.thumbnail,
      image = prepared.toPNG(),
      mime = "image/png";
    if (!image.length) throw new Error("屏幕或窗口无法截图。");
    while (image.length > MAX_SCREENSHOT_BYTES) {
      for (const quality of [92, 82, 72]) {
        image = prepared.toJPEG(quality);
        if (image.length && image.length <= MAX_SCREENSHOT_BYTES) break;
      }
      mime = "image/jpeg";
      if (image.length && image.length <= MAX_SCREENSHOT_BYTES) break;
      const previous = prepared.getSize(),
        width = Math.max(1, Math.floor(previous.width * 0.8)),
        height = Math.max(1, Math.floor(previous.height * 0.8));
      if (width === previous.width && height === previous.height)
        throw new Error("截图编码失败。");
      prepared = prepared.resize({ width, height, quality: "best" });
      image = prepared.toPNG();
      mime = "image/png";
      if (!image.length) throw new Error("截图编码失败。");
    }
    return {
      image_data: `data:${mime};base64,${image.toString("base64")}`,
      source_id: source.id,
      captured_at: capturedAt,
    };
  }

  async function getAudioCaptureSource() {
    // System loopback is independent of the user-selected screenshot window.
    const sources = await getSources({ width: 0, height: 0 }, ["screen"]);
    const primaryId = String(screen.getPrimaryDisplay().id);
    const source = sources.find(
      (candidate) => String(candidate.display_id) === primaryId,
    );
    if (source) return source;
    if (sources.length === 1) return sources[0];
    throw new Error("无法确定系统音频采集使用的显示器，请检查系统屏幕权限。");
  }

  return { listSources, selectSource, captureSnapshot, getAudioCaptureSource };
}

module.exports = { createScreenCaptureService };

// Use the operating system's title bar, resize handles, shadow and corners.
// Opening the code pane only changes the page layout, not native window bounds.
const DESKTOP_WINDOW_OPTIONS = {
  width: 1100,
  height: 780,
  minWidth: 620,
  minHeight: 440,
  frame: true,
  transparent: false,
  backgroundColor: "#f5f5f5",
  resizable: true,
  minimizable: true,
  maximizable: true,
  hasShadow: true,
  show: false,
  alwaysOnTop: false,
};

module.exports = { DESKTOP_WINDOW_OPTIONS };

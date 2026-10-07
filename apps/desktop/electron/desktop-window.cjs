// Use the operating system's title bar, resize handles, shadow and corners.
// Opening the code pane only changes the page layout, not native window bounds.
const DESKTOP_WINDOW_OPTIONS = {
  width: 1100,
  height: 780,
  minWidth: 620,
  minHeight: 440,
  frame: true,
  transparent: true,
  backgroundColor: "#00000000",
  resizable: true,
  minimizable: true,
  maximizable: true,
  hasShadow: true,
  show: false,
  alwaysOnTop: true,
};

module.exports = { DESKTOP_WINDOW_OPTIONS };

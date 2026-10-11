// A frameless, transparent overlay sized by the page to its content. It never
// takes focus on click; the page asks for focus only while its text box is
// used. Hidden from the taskbar; the tray and shortcuts bring it back.
const DESKTOP_WINDOW_OPTIONS = {
  width: 460,
  height: 64,
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  hasShadow: false,
  skipTaskbar: true,
  focusable: false,
  show: false,
  alwaysOnTop: true,
};

module.exports = { DESKTOP_WINDOW_OPTIONS };

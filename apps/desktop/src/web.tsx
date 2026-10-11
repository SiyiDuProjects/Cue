import "./styles.css";
import ReactDOM from "react-dom/client";
import Web from "../../../packages/chat-ui/Web";

// The cloud site's web page. The shared answer card copies through
// window.cue; a browser page uses the clipboard API directly.
window.cue = {
  copy: (text: string) => navigator.clipboard.writeText(text),
} as unknown as Window["cue"];
ReactDOM.createRoot(document.getElementById("root")!).render(<Web />);

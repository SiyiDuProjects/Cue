import "./styles.css";
import ReactDOM from "react-dom/client";
import Content from "../../../packages/chat-ui/Content";
import { installMacTranscription } from "./directTranscription";

// Mac only: the native window owns the controls. This page renders answers
// and runs the shared transcription client on PCM sent by the native host.
installMacTranscription();
ReactDOM.createRoot(document.getElementById("root")!).render(<Content />);

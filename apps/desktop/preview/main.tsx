import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "./base.css";
import "@heroui-pro/react/css/components/resizable.css";
import "@heroui-pro/react/css/components/chat-conversation.css";
import "./preview.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

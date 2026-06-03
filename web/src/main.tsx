import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HtmlPreviewPage } from "./HtmlPreviewPage";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <React.StrictMode>
    {window.location.pathname === "/html-preview" ? <HtmlPreviewPage /> : <App />}
  </React.StrictMode>,
);

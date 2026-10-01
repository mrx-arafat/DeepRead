import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/noto-sans-bengali";
import "./styles.css";

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// No StrictMode: its double-invoked effects would start, abort and restart every AI request in dev.
createRoot(document.getElementById("root")!).render(<App />);

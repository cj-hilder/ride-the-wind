import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Custom domain — served from the root.
export default defineConfig({
  plugins: [react()],
  base: "/",
});

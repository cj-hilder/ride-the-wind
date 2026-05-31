import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site under /<repo>/, so base must be that path.
export default defineConfig({
  plugins: [react()],
  base: "/ride-the-wind/",
});

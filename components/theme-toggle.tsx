"use client";

import { useTheme } from "next-themes";
import { SunIcon, MoonIcon } from "lucide-react";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <button
      aria-label="Toggle theme"
      className={className}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      type="button"
    >
      <SunIcon key={`sun-${theme}`} className="hidden size-3.5 dark:block animate-icon-in" />
      <MoonIcon key={`moon-${theme}`} className="block size-3.5 dark:hidden animate-icon-in" />
    </button>
  );
}

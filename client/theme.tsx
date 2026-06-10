import React, { createContext, useContext, useEffect, useState } from "react";
import { useColorScheme } from "react-native";

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentAlt: string;
  success: string;
  danger: string;
  warning: string;
  streakColor: string;
  coinColor: string;
  timerGlow: string;
  timerTrack: string;
  timerProgress: string;
}

export const lightTheme: ThemeColors = {
  background: "#f0fdfa", // Very light teal/blue
  surface: "#ffffff",
  surfaceAlt: "#f8fafc",
  border: "#e2e8f0",
  textPrimary: "#0f172a",
  textSecondary: "#475569",
  textMuted: "#94a3b8",
  accent: "#6366f1", // Vibrant purple/blue
  accentAlt: "#f59e0b", // Orange/amber
  success: "#10b981", // Green
  danger: "#ef4444", // Red
  warning: "#f59e0b", // Amber
  streakColor: "#ff7b00", // Vibrant orange
  coinColor: "#fbbf24", // Gold
  timerGlow: "#818cf8", // Lighter purple
  timerTrack: "#e0e7ff", // Light blue/purple track
  timerProgress: "#6366f1", // Purple progress
};

export const darkTheme: ThemeColors = {
  background: "#050b14", // Deep dark blue
  surface: "#0a1622",
  surfaceAlt: "#132335",
  border: "#1c2f3d",
  textPrimary: "#ffffff",
  textSecondary: "#8da6ba",
  textMuted: "#4b6478",
  accent: "#818cf8", // Lighter purple/blue for dark mode
  accentAlt: "#fbbf24", // Amber for dark mode
  success: "#10b981", // Green
  danger: "#ef4444", // Red
  warning: "#f59e0b", // Amber
  streakColor: "#ff9100", // Bright orange
  coinColor: "#fcd34d", // Bright gold
  timerGlow: "#4f46e5", // Deeper purple glow
  timerTrack: "#1c2f3d", // Dark track
  timerProgress: "#818cf8", // Purple progress
};

interface ThemeContextType {
  mode: ThemeMode;
  colors: ThemeColors;
  toggleTheme: () => void;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

const THEME_STORAGE_KEY = "study-buddy-theme";

export function ThemeProvider({ children }: ThemeProviderProps) {
  const systemColorScheme = useColorScheme();
  
  // Default to light mode on first open, unless the user previously saved a preference
  const [mode, setMode] = useState<ThemeMode>("light");

  useEffect(() => {
    // Try to load from localStorage on web
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
        if (saved && (saved === "light" || saved === "dark")) {
          setMode(saved);
        }
      } catch (e) {
        console.warn("Failed to read theme from localStorage");
      }
    }
  }, []);

  const toggleTheme = () => {
    setMode((prev) => {
      const next = prev === "light" ? "dark" : "light";
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch (e) {
          console.warn("Failed to save theme to localStorage");
        }
      }
      return next;
    });
  };

  const setThemeMode = (newMode: ThemeMode) => {
    setMode(newMode);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, newMode);
      } catch (e) {
        console.warn("Failed to save theme to localStorage");
      }
    }
  };

  const colors = mode === "light" ? lightTheme : darkTheme;

  return (
    <ThemeContext.Provider value={{ mode, colors, toggleTheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

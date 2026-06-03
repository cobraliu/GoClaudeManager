import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { LoginPage } from "./pages/LoginPage";
import { SessionsPage } from "./pages/SessionsPage";
import { AdminPage } from "./pages/AdminPage";
import { MobilePage } from "./pages/MobilePage";
import { JsonlChatToolPage } from "./pages/JsonlChatToolPage";
import { ShareViewer } from "./components/ShareViewer";
import type { ShareType } from "./api/sessionApi";
import { startMermaidObserver } from "./lib/mermaid";
import { apiPath } from "./lib/baseUrl";
import "./index.css";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";

startMermaidObserver();

export type Theme = "dark" | "light";

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mobile;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
}

function getIsAdminFromToken(): boolean {
  const token = localStorage.getItem("token");
  if (!token) return false;
  return decodeJwtPayload(token).is_admin === true
    || localStorage.getItem("is_admin") === "true";
}

// Detect autologin param before first render so we can suppress the login flash.
const _autologinParam = new URLSearchParams(window.location.search).get("autologin");

function App() {
  const [loggedIn, setLoggedIn] = useState(() => !!localStorage.getItem("token") || !!_autologinParam);
  const [username, setUsername] = useState(() => localStorage.getItem("username") || "");
  const [role, setRole] = useState<"admin" | "user">(
    () => (localStorage.getItem("role") as "admin" | "user") || "user"
  );
  const [isAdminUser, setIsAdminUser] = useState(() => getIsAdminFromToken());
  const [viewAsAdmin, setViewAsAdmin] = useState(false);
  const [viewTool, setViewTool] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) || "dark"
  );
  const isMobile = useIsMobile();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!_autologinParam) return;
    // Remove token from URL immediately to avoid sharing it accidentally.
    window.history.replaceState({}, "", window.location.pathname);
    fetch(apiPath(`/api/auth/autologin?token=${encodeURIComponent(_autologinParam)}`))
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { token: string; username: string; role: "admin" | "user"; is_admin: boolean }) => {
        localStorage.setItem("token", data.token);
        localStorage.setItem("username", data.username);
        localStorage.setItem("role", data.role);
        localStorage.setItem("is_admin", String(data.is_admin));
        setUsername(data.username);
        setRole(data.role);
        setIsAdminUser(data.is_admin);
        setLoggedIn(true);
      })
      .catch(() => {
        // Autologin failed — show login page normally.
        setLoggedIn(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  const handleLogin = (u: string, r: "admin" | "user", is_admin: boolean) => {
    setUsername(u);
    setRole(r);
    setIsAdminUser(is_admin);
    setLoggedIn(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
    localStorage.removeItem("is_admin");
    setLoggedIn(false);
    setUsername("");
    setRole("user");
    setIsAdminUser(false);
    setViewAsAdmin(false);
  };

  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (viewTool) {
    return (
      <JsonlChatToolPage
        onBack={() => setViewTool(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (viewAsAdmin) {
    return (
      <AdminPage
        onLogout={handleLogout}
        onBack={() => setViewAsAdmin(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (isMobile) {
    return (
      <MobilePage
        username={username}
        onLogout={handleLogout}
        onSwitchToAdmin={isAdminUser ? () => setViewAsAdmin(true) : undefined}
        onOpenTool={() => setViewTool(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return (
    <SessionsPage
      username={username}
      onLogout={handleLogout}
      onSwitchToAdmin={isAdminUser ? () => setViewAsAdmin(true) : undefined}
      onOpenTool={() => setViewTool(true)}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}

// Public, no-auth share viewer. Suffix-anchored so it works under any ROOT_PATH.
const _shareMatch = window.location.pathname.match(/\/share\/(full|limited|chat)\/([0-9a-f]{32})\.html$/);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {_shareMatch
      ? <ShareViewer shareType={_shareMatch[1] as ShareType} hash={_shareMatch[2]} />
      : <App />}
  </React.StrictMode>
);

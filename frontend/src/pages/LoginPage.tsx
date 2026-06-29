import { useState, useEffect, useRef } from "react";
import { login, loginWithGoogle, getGoogleClientId } from "../api/sessionApi";
import { IconSun, IconMoon } from "../components/icons";

interface Props {
  onLogin: (username: string, role: "admin" | "user", is_admin: boolean) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: object) => void;
          renderButton: (el: HTMLElement, cfg: object) => void;
          prompt: () => void;
        };
      };
    };
    _googleInitialized?: boolean;
  }
}

export function LoginPage({ onLogin, theme, onToggleTheme }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  const handleLoginResponse = (res: { token: string; username: string; role: "admin" | "user"; is_admin: boolean }) => {
    localStorage.setItem("token", res.token);
    localStorage.setItem("username", res.username);
    localStorage.setItem("role", res.role);
    localStorage.setItem("is_admin", String(res.is_admin));
    onLogin(res.username, res.role, res.is_admin);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await login(username, password);
      handleLoginResponse(res);
    } catch {
      setError("Login failed. Check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  // Load Google client ID from backend
  useEffect(() => {
    getGoogleClientId()
      .then(({ client_id }) => { if (client_id) setGoogleClientId(client_id); })
      .catch(() => {});
  }, []);

  // Load Google Identity Services script and render button
  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current) return;

    const initGoogle = () => {
      window.google?.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (resp: { credential: string }) => {
          setError("");
          setLoading(true);
          try {
            const res = await loginWithGoogle(resp.credential);
            handleLoginResponse(res);
          } catch {
            setError("Google login failed.");
          } finally {
            setLoading(false);
          }
        },
      });
      if (googleBtnRef.current) {
        window.google?.accounts.id.renderButton(googleBtnRef.current, {
          theme: theme === "dark" ? "filled_black" : "outline",
          size: "large",
          width: 276,
          text: "signin_with",
          shape: "rectangular",
        });
      }
    };

    if (window.google) {
      initGoogle();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = initGoogle;
    document.head.appendChild(script);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleClientId]);

  // Re-render Google button on theme change
  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current || !window.google) return;
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      theme: theme === "dark" ? "filled_black" : "outline",
      size: "large",
      width: 276,
      text: "signin_with",
      shape: "rectangular",
    });
  }, [theme, googleClientId]);

  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
      <button
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        style={{ position: "absolute", top: 16, right: 16, background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 14, color: "var(--text-muted)" }}
      >
        {theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>
      <form
        onSubmit={handleSubmit}
        style={{ width: "min(340px, 92vw)", padding: 32, background: "var(--bg-modal)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <h2 style={{ textAlign: "center", marginBottom: 8 }}>Claude Manager</h2>
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={inputStyle}
          autoFocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
        />
        {error && <div style={{ color: "#d9534f", fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={loading || !username || !password}
          style={{ background: "#58a6ff", color: "#fff", padding: "10px 16px", border: "none", borderRadius: 6, cursor: loading || !username || !password ? "default" : "pointer", fontSize: 14 }}
        >
          {loading ? "Logging in..." : "Login"}
        </button>

        {googleClientId && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-faint)", fontSize: 12 }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              or
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div ref={googleBtnRef} style={{ display: "flex", justifyContent: "center" }} />
          </>
        )}
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid #333",
  borderRadius: 6,
  padding: "10px 14px",
  color: "var(--text-body)",
  fontSize: 14,
  outline: "none",
};

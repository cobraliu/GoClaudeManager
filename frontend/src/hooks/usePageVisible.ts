import { useEffect, useState } from "react";

// usePageVisible returns whether the tab is currently visible, tracking the
// Page Visibility API. Poll effects depend on it so they tear down their
// setInterval when the tab is backgrounded and re-fetch + resume on return —
// a hidden tab should not keep hammering the server every 1.5–3s.
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

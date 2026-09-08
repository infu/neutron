import { useCallback, useEffect, useRef, useState } from "react";
import { oc, subscribeChats } from "../shared/rpc.ts";
import type { ChatVM, MessageVM, WhoAmIVM } from "../shared/protocol.ts";

export function useWhoami(): {
  who: WhoAmIVM | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [who, setWho] = useState<WhoAmIVM | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(0);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const current = ++request.current;
    oc.whoami()
      .then((w) => {
        if (current !== request.current) return;
        // Only an authoritative resident response changes the account state.
        attempts.current = 0;
        setWho(w);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (current !== request.current) return;
        attempts.current += 1;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        timer.current = setTimeout(reload, Math.min(600 * attempts.current, 4000));
      });
  }, []);

  useEffect(() => {
    reload();
    return () => {
      request.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  // Reconnect after workspace/resident restarts without treating an outage as logout.
  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [reload]);

  return { who, loading, error, reload };
}

export function useChats(enabled: boolean): {
  chats: ChatVM[];
  busy: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [chats, setChats] = useState<ChatVM[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = useRef(0);
  const load = useCallback((refreshNetwork = false) => {
    if (!enabled) return;
    const request = ++token.current;
    setBusy(true);
    (refreshNetwork ? oc.refresh() : oc.listChats())
      .then((c) => {
        if (request !== token.current) return;
        setChats(c); // replace in place — never blanks the list first
        setError(null);
      })
      .catch((e: unknown) => { if (request === token.current) setError((e as Error).message); })
      .finally(() => { if (request === token.current) setBusy(false); });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const stop = subscribeChats(() => load());
    return () => { token.current += 1; stop(); };
  }, [enabled, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { chats, busy, error, refresh };
}

export function useMessages(chatId: string | null): {
  messages: MessageVM[];
  busy: boolean;
  error: string | null;
  reload: () => void;
} {
  const [messages, setMessages] = useState<MessageVM[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  const reload = useCallback(() => {
    if (!chatId) {
      setMessages([]);
      return;
    }
    const t = ++token.current;
    setBusy(true);
    oc.readMessages(chatId)
      .then((m) => {
        if (t === token.current) { setMessages(m); setError(null); }
      })
      .catch((e: unknown) => {
        if (t === token.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (t === token.current) setBusy(false);
      });
  }, [chatId]);

  // Switching chats clears immediately so a stale conversation never shows.
  useEffect(() => {
    setMessages([]);
    setError(null);
    reload();
    return () => { token.current += 1; };
  }, [chatId, reload]);

  // Refresh the open conversation when the resident signals new data.
  useEffect(() => {
    if (!chatId) return;
    return subscribeChats(() => reload());
  }, [chatId, reload]);

  return { messages, busy, error, reload };
}

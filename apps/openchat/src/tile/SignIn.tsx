import { useCallback, useEffect, useRef, useState } from "react";
import { cx, nt } from "neutron-design-system";
import { IoMailOutline, IoArrowForward, IoReloadOutline, IoCheckmarkCircle } from "react-icons/io5";
import type { SignInStateVM } from "../shared/protocol.ts";
import { oc } from "../shared/rpc.ts";
import { submitOnEnter } from "./ui.tsx";

type Phase = "email" | "await";

export function SignIn({ onSignedIn, pendingEmail }: { onSignedIn: () => void; pendingEmail?: string | null }): React.ReactNode {
  const [phase, setPhase] = useState<Phase>(pendingEmail ? "await" : "email");
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [username, setUsername] = useState("");
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<SignInStateVM | null>(null);
  const [needUsername, setNeedUsername] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const session = useRef(0);
  const polling = useRef(false);
  const usernameRef = useRef(username);
  usernameRef.current = username;

  const start = useCallback(async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await oc.signInStart(email.trim());
      if (res.accepted) {
        setStatus({ phase: "ready", email: email.trim(), emailSent: false, code: null });
        setPhase("await");
      } else {
        setNote(res.message ?? "Could not start sign-in");
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [email, busy]);

  const pollDelegation = useCallback(async (): Promise<boolean> => {
    if (polling.current) return false;
    polling.current = true;
    const current = session.current;
    try {
      const poll = await oc.signInPoll(usernameRef.current.trim() || undefined);
      if (current !== session.current) return false;
      if (poll.status === "logged_in") {
        onSignedIn();
        return true;
      }
      if (poll.status === "pending" && poll.message === "username_required") setNeedUsername(true);
      else if (poll.status === "expired") {
        setNote("The link expired — start again.");
        setPhase("email");
        setStatus(null);
      } else if (poll.status === "error" && poll.message) setNote(poll.message);
      return false;
    } finally { polling.current = false; }
  }, [onSignedIn]);

  // While awaiting confirmation, keep the status (code / errors) fresh and poll
  // for the delegation once the code is ready.
  useEffect(() => {
    if (phase !== "await") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const st = await oc.signInStatus();
        if (!alive) return;
        setStatus(st);
        if (st.phase === "ready") await pollDelegation();
      } catch {
        /* transient; keep trying */
      } finally {
        if (alive) timer = setTimeout(() => void tick(), 2500);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, pollDelegation]);

  const completeWithLink = useCallback(async () => {
    if (!link.trim() || completing) return;
    setCompleting(true);
    const current = session.current;
    setNote(null);
    try {
      const res = await oc.signInComplete(link.trim());
      if (current !== session.current) return;
      if (!res.ok) {
        setNote(res.message ?? "Could not use that link");
      } else {
        setLink("");
        if (!(await pollDelegation()) && current === session.current) setNote("Confirmed — finishing sign-in…");
      }
    } catch (e) {
      if (current === session.current) setNote((e as Error).message);
    } finally {
      if (current === session.current) setCompleting(false);
    }
  }, [link, completing, pollDelegation]);

  useEffect(() => () => { session.current += 1; }, []);

  const restart = useCallback(() => {
    session.current += 1;
    setCompleting(false);
    setPhase("email");
    setStatus(null);
    setNeedUsername(false);
    setUsername("");
    setNote(null);
    setLink("");
  }, []);

  return (
    <div className="oc-signin">
      <div className="oc-signin__card">
        <div className="oc-signin__brand">
          <IoMailOutline size={20} aria-hidden />
          <span>Sign in to OpenChat</span>
        </div>

        {phase === "email" ? (
          <div className="oc-signin__form">
            <label className={nt.field}>
              <span className={nt.label}>Email</span>
              <input
                className={nt.input}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={submitOnEnter(() => void start())}
                disabled={busy}
                data-tid="oc-email"
              />
            </label>
            <button
              className={cx(nt.button, "oc-signin__submit")}
              type="button"
              onClick={() => void start()}
              disabled={busy || !email.trim()}
            >
              {busy ? <IoReloadOutline className="oc-spin" size={15} aria-hidden /> : <IoArrowForward size={15} aria-hidden />}
              <span>Send magic link</span>
            </button>
            <p className={nt.help}>
              You'll sign in with your email. This creates or reuses an OpenChat account controlled
              from this Neutron.
            </p>
          </div>
        ) : (
          <div className="oc-signin__await">
            {status?.phase === "error" ? (
              <p className={nt.error}>{status.message}</p>
            ) : (
              <>
                <p className={nt.text}>
                  Open the email from OpenChat{status && status.phase === "ready" ? (
                    <> (sent to <strong>{status.email}</strong>)</>
                  ) : null}{" "}
                  and paste the sign-in link here.
                </p>
                <div className="oc-search">
                  <input
                    className={cx(nt.input, "oc-search__input")}
                    placeholder="Paste the link from the email"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    onKeyDown={submitOnEnter(() => void completeWithLink())}
                    disabled={completing}
                    data-tid="oc-link"
                  />
                  <button
                    className={cx(nt.button, "oc-signin__finish")}
                    type="button"
                    onClick={() => void completeWithLink()}
                    disabled={completing || !link.trim()}
                  >
                    {completing ? (
                      <IoReloadOutline className="oc-spin" size={15} aria-hidden />
                    ) : (
                      <IoCheckmarkCircle size={15} aria-hidden />
                    )}
                    <span>Finish</span>
                  </button>
                </div>
                {status?.phase === "ready" && status.code ? (
                  <p className={cx(nt.help, "oc-signin__hint")}>
                    If OpenChat's own page asks for a verification code, it is{" "}
                    <span className="oc-code oc-code--inline">{status.code}</span>. Pasting the link
                    above does this for you.
                  </p>
                ) : null}
                {needUsername ? (
                  <label className={nt.field}>
                    <span className={nt.label}>Choose a username</span>
                    <input
                      className={nt.input}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={submitOnEnter(() => void pollDelegation().catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e))))}
                      placeholder="username"
                      data-tid="oc-username"
                    />
                    <span className={nt.help}>New account — pick a username to finish.</span>
                  </label>
                ) : null}
              </>
            )}
            <button className={cx(nt.buttonGhost, "oc-signin__restart")} type="button" onClick={restart}>
              Use a different email
            </button>
          </div>
        )}

        {note ? <p className={cx(nt.meta, "oc-signin__note")}>{note}</p> : null}
      </div>
    </div>
  );
}

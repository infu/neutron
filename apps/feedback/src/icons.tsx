export type IconName = "feedback" | "issue" | "idea" | "app" | "arrow" | "back" | "plus" | "refresh" | "lock" | "inbox" | "check" | "copy" | "support" | "close";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    feedback: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 3V11.5A7.5 7.5 0 0 1 10.5 4h2a7.5 7.5 0 0 1 7.5 7.5Z" /><path d="M8 10h7M8 14h4" /></>,
    issue: <><circle cx="12" cy="12" r="8" /><path d="M12 8v5M12 16h.01" /></>,
    idea: <><path d="M9 17c0-2-4-3.5-4-7a7 7 0 0 1 14 0c0 3.5-4 5-4 7M9 17h6M9 20h6M10 23h4" /></>,
    app: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14v7M14 17.5h7" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m14 5-7 7 7 7M7 12h14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.5 6.5A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.5 5.5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    inbox: <><path d="m5 4-3 9v7h20v-7l-3-9H5ZM2 13h6l2 3h4l2-3h6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    support: <><path d="M4 13v-2a8 8 0 0 1 16 0v2M20 17c0 3-3 4-6 4" /><rect x="2" y="11" width="5" height="7" rx="2" /><rect x="17" y="11" width="5" height="7" rx="2" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg className={`fb-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
